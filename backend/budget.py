# budget.py — POST /api/budget/breakdown: a chat transcript in, a chartable budget out.
#
# The user talks in plain language ("I make 4200 after tax, rent is 1500, groceries maybe
# 600"). The model's only job is to pull the numbers out of that and say something back.
# Every derived figure — what is spent, what is left, each share of the salary — is computed
# here in Python, because a model asked to divide will occasionally be confidently wrong and
# the whole chart is built on those numbers.

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

try:  # works whether backend/ is a package or a flat script dir
    from .errors import LLMError
    from .provider import complete_structured_with_model
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from errors import LLMError  # type: ignore[no-redef]
    from provider import complete_structured_with_model  # type: ignore[no-redef]


class InconsistentBudget(LLMError):
    """The model returned a category list that does not line up with its amounts."""

    code = "inconsistent_budget"
    status = 502


# The chart palette has exactly 8 colours, and one is reserved for what is left over.
# Past that, colour stops carrying meaning — so the tail is grouped rather than dropped.
MAX_EXPENSE_SLICES = 7
OTHER_LABEL = "Other"
LEFTOVER_LABEL = "Left over"


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class BudgetRequest(BaseModel):
    """The whole conversation so far. The client keeps it; the backend stays stateless."""

    messages: list[Turn] = Field(min_length=1, max_length=40)


class BudgetReading(BaseModel):
    """What the model returns. Flat and parallel-array shaped on purpose — the OpenAI
    fallback in the model chain rejects nested schemas, and a chart is not worth losing
    the fallback over."""

    reply: str = Field(description="What you say back to the user. One or two sentences, plain language.")
    currency: str = Field(description="ISO 4217 code the user is talking in, e.g. 'CAD'. Guess from context; never convert.")
    monthly_income: float = Field(description="Net monthly income if the user has stated it, otherwise 0.")
    category_names: list[str] = Field(description="Short expense labels, e.g. 'Rent', 'Groceries'. Empty if none given yet.")
    category_amounts: list[float] = Field(description="Monthly amount per category, same order and length as category_names.")
    needs_more: bool = Field(description="True while income or expenses are still missing.")
    missing: list[str] = Field(description="What you still need from the user. Empty when nothing is missing.")


class Slice(BaseModel):
    name: str
    amount: float
    share: float = Field(description="Fraction of monthly income, 0..1. Zero when income is unknown.")


class BudgetResponse(BaseModel):
    reply: str
    currency: str
    monthly_income: float
    slices: list[Slice] = Field(description="Expenses largest-first, then what is left over. At most 8, chart-ready.")
    spent: float
    leftover: float
    leftover_share: float
    overspent: bool = Field(description="True when the stated expenses exceed the stated income.")
    needs_more: bool
    missing: list[str]
    model: str


SYSTEM = (
    "You are a budget assistant having a short conversation. The user tells you what they "
    "earn per month and what they spend it on, in whatever order and wording they like. "
    "Your job is to pull those numbers out and keep asking for what is still missing.\n\n"
    "Rules you do not break:\n"
    "- Never invent or estimate a number the user did not give. If they have not said what "
    "rent is, it is not in the list.\n"
    "- Amounts are monthly. Convert an explicitly weekly or daily figure to monthly and say "
    "in your reply that you did.\n"
    "- Keep category labels short and reusable: Rent, Groceries, Transport, Utilities, "
    "Subscriptions, Eating out, Debt, Savings.\n"
    "- Merge duplicates. If the user mentions groceries twice, that is one category.\n"
    "- Do no arithmetic. Do not total the expenses, do not work out what is left, do not "
    "compute percentages. That is done for you, and quoting your own version would "
    "contradict the chart the user is looking at.\n"
    "- Carry everything already established in the conversation into every answer. The list "
    "you return replaces the previous one, so a category you drop disappears from the chart.\n"
    "- Write the reply with plain punctuation: commas, periods, parentheses. Never use an em "
    "dash or an en dash; the interface's typography does not allow them."
)


def _group(pairs: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Largest first, tail past the palette merged into one 'Other'. Never drops a number."""
    ordered = sorted(pairs, key=lambda p: p[1], reverse=True)
    if len(ordered) <= MAX_EXPENSE_SLICES:
        return ordered
    head = ordered[: MAX_EXPENSE_SLICES - 1]
    tail_total = sum(amount for _, amount in ordered[MAX_EXPENSE_SLICES - 1 :])
    return [*head, (OTHER_LABEL, tail_total)]


def build(reading: BudgetReading) -> BudgetResponse:
    """The arithmetic. Deterministic, and the only source of every number on the chart."""
    if len(reading.category_names) != len(reading.category_amounts):
        raise InconsistentBudget(
            f"The model returned {len(reading.category_names)} category names but "
            f"{len(reading.category_amounts)} amounts. Nothing is guessed to paper over that. Retry."
        )

    # A negative amount is not a budget line; drop it rather than draw a negative arc.
    pairs = [
        (name.strip(), float(amount))
        for name, amount in zip(reading.category_names, reading.category_amounts)
        if name.strip() and amount > 0
    ]
    income = max(0.0, reading.monthly_income)
    spent = sum(amount for _, amount in pairs)
    leftover = income - spent

    # share is a fraction of income, so it is meaningless until income is known.
    def share(amount: float) -> float:
        return round(amount / income, 4) if income > 0 else 0.0

    slices = [
        Slice(name=name, amount=round(amount, 2), share=share(amount))
        for name, amount in _group(pairs)
    ]
    if income > 0 and leftover > 0:
        slices.append(Slice(name=LEFTOVER_LABEL, amount=round(leftover, 2), share=share(leftover)))

    return BudgetResponse(
        reply=reading.reply,
        currency=(reading.currency or "USD").upper()[:3],
        monthly_income=round(income, 2),
        slices=slices,
        spent=round(spent, 2),
        leftover=round(leftover, 2),
        leftover_share=share(leftover) if leftover > 0 else 0.0,
        overspent=income > 0 and spent > income,
        needs_more=reading.needs_more or income <= 0 or not pairs,
        missing=reading.missing,
        model="",
    )


budget_router = APIRouter(prefix="/api/budget", tags=["budget"])


@budget_router.post("/breakdown", response_model=BudgetResponse)
def breakdown(request: BudgetRequest) -> BudgetResponse:
    """Transcript in, chart-ready budget out. `def` not `async def`: the blocking model
    call runs in a threadpool, so one slow turn does not freeze the other clients."""
    transcript = "\n".join(f"{turn.role}: {turn.content}" for turn in request.messages)
    prompt = (
        f"{transcript}\n\n"
        "Return the full budget as understood from the whole conversation above, plus your "
        "next reply to the user."
    )

    reading, model = complete_structured_with_model(prompt, BudgetReading, system=SYSTEM)
    response = build(reading)
    response.model = model
    return response
