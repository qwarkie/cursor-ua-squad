# affordability.py — POST /api/affordability/assess: a priced item + a salary profile -> a verdict.
#
# The split here is the whole point of the endpoint: every number is computed in Python from
# the user's own figures, and the model is handed those numbers and asked only for the words.
# A model that is allowed to do the arithmetic will confidently produce a wrong month count,
# and the one thing a money tool cannot do is be confidently wrong about a month count.

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


class ImpossibleBudget(LLMError):
    """Expenses swallow the whole salary, so there is no capacity to reason about."""

    code = "impossible_budget"
    status = 422


# Hours in an average working month: 40 h/week x 52 weeks / 12 months.
HOURS_PER_MONTH = 173.33

Verdict = Literal["easy", "affordable", "stretch", "plan_it", "out_of_reach"]

# Upper bound of price / monthly disposable income for each verdict, in order.
VERDICT_BANDS: list[tuple[float, Verdict]] = [
    (0.10, "easy"),
    (0.35, "affordable"),
    (1.00, "stretch"),
    (3.00, "plan_it"),
]


class Profile(BaseModel):
    """The user's own figures. Monthly, net, in one currency — no conversion happens here."""

    monthly_income: float = Field(gt=0, description="Net monthly income, after tax.")
    monthly_expenses: float = Field(ge=0, description="Rent, bills, food — everything already committed.")
    savings: float = Field(ge=0, description="Cash on hand right now.")
    currency: str = Field(min_length=3, max_length=3, description="ISO 4217 code, e.g. 'CAD'.")
    # 0.30 means "I am willing to put 30% of what is left over towards this".
    commit_share: float = Field(default=0.30, gt=0, le=1, description="Share of disposable income this purchase may claim.")
    # Months of expenses that must stay untouched. Spending below this is flagged, never blocked.
    emergency_months: float = Field(default=1.0, ge=0, le=12, description="Months of expenses to keep as a buffer.")


class AssessRequest(BaseModel):
    profile: Profile
    item_name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=40)
    price: float = Field(gt=0, description="Price to test, in the profile's currency.")
    # The frontend sends the grounded price here when the user accepted one, so the advice
    # can say which number it reasoned about rather than the model's first guess.
    price_basis: str = Field(default="", max_length=400)


class Math(BaseModel):
    """Every field here is arithmetic on the request. Nothing in this model is generated."""

    verdict: Verdict
    disposable_income: float = Field(description="monthly_income - monthly_expenses.")
    monthly_capacity: float = Field(description="disposable_income * commit_share.")
    share_of_income: float = Field(description="price / monthly_income.")
    share_of_disposable: float = Field(description="price / disposable_income.")
    months_to_save: float = Field(description="Months of monthly_capacity needed, after spendable savings.")
    work_hours: float = Field(description="Hours of work this price costs at the implied hourly rate.")
    hourly_rate: float
    spendable_savings: float = Field(description="Savings above the emergency buffer.")
    payable_from_savings: bool
    breaks_emergency_fund: bool = Field(description="True if paying cash today drops below the buffer.")


class Advice(BaseModel):
    """The model's half. Flat by necessity — the OpenAI fallback rejects nested schemas."""

    headline: str = Field(description="One short line the user reads first. No numbers the input did not contain.")
    reasoning: str = Field(description="Two or three sentences on why this verdict is what it is.")
    action: str = Field(description="One concrete next step, e.g. an amount to set aside per week.")
    tradeoff: str = Field(description="What this purchase costs in something the user recognises.")
    alternatives: list[str] = Field(description="Cheaper ways to get the same outcome. Empty if none honestly apply.")
    risk: Literal["low", "medium", "high"] = Field(description="Risk this purchase poses to the user's buffer.")


class AssessResponse(BaseModel):
    item_name: str
    category: str
    price: float
    currency: str
    math: Math
    advice: Advice
    model: str


ADVICE_SYSTEM = (
    "You are a blunt, numerate financial assistant. Every figure you need has already been "
    "computed and is given to you — quote those numbers, never recompute or round them into a "
    "different number, and never invent a figure that is not in the input. No moralising about "
    "the purchase; the user decides. If the buffer is at risk, say so in one sentence."
)


def compute(profile: Profile, price: float) -> Math:
    """The formula. Deterministic, testable by hand, and the only source of every number shown."""
    disposable = profile.monthly_income - profile.monthly_expenses
    if disposable <= 0:
        raise ImpossibleBudget(
            f"Monthly expenses ({profile.monthly_expenses:.0f}) are at or above monthly income "
            f"({profile.monthly_income:.0f}), so there is no disposable income to spend from. "
            "Fix the profile figures before assessing a purchase."
        )

    capacity = disposable * profile.commit_share
    buffer = profile.monthly_expenses * profile.emergency_months
    spendable = max(0.0, profile.savings - buffer)
    shortfall = max(0.0, price - spendable)
    hourly = profile.monthly_income / HOURS_PER_MONTH

    share_of_disposable = price / disposable
    verdict: Verdict = "out_of_reach"
    for ceiling, band in VERDICT_BANDS:
        if share_of_disposable <= ceiling:
            verdict = band
            break

    return Math(
        verdict=verdict,
        disposable_income=round(disposable, 2),
        monthly_capacity=round(capacity, 2),
        share_of_income=round(price / profile.monthly_income, 4),
        share_of_disposable=round(share_of_disposable, 4),
        months_to_save=round(shortfall / capacity, 2),
        work_hours=round(price / hourly, 1),
        hourly_rate=round(hourly, 2),
        spendable_savings=round(spendable, 2),
        payable_from_savings=price <= spendable,
        breaks_emergency_fund=price > spendable and price <= profile.savings,
    )


affordability_router = APIRouter(prefix="/api/affordability", tags=["affordability"])


@affordability_router.post("/assess", response_model=AssessResponse)
def assess(request: AssessRequest) -> AssessResponse:
    """Price in, verdict out. `def` not `async def`: the blocking model call runs in a threadpool."""
    profile = request.profile
    math = compute(profile, request.price)

    prompt = "\n".join(
        [
            f"Item: {request.item_name} ({request.category}), {request.price:.2f} {profile.currency}.",
            f"Price basis: {request.price_basis or 'not stated'}.",
            "",
            "The user's own monthly figures, in the same currency:",
            f"- net income {profile.monthly_income:.2f}, committed expenses {profile.monthly_expenses:.2f}",
            f"- disposable income {math.disposable_income:.2f}",
            f"- willing to put {profile.commit_share:.0%} of that towards this, i.e. {math.monthly_capacity:.2f}/month",
            f"- savings {profile.savings:.2f}, of which {math.spendable_savings:.2f} is above the "
            f"{profile.emergency_months:g}-month buffer",
            "",
            "Already computed — use these exact numbers:",
            f"- this price is {math.share_of_disposable:.1%} of one month of disposable income",
            f"- {math.share_of_income:.1%} of one month of net income",
            f"- {math.work_hours:.1f} hours of work at {math.hourly_rate:.2f}/hour",
            f"- {math.months_to_save:.2f} months of saving at the committed rate",
            f"- payable from savings today: {math.payable_from_savings}",
            f"- paying cash today breaks the emergency buffer: {math.breaks_emergency_fund}",
            f"- verdict computed from the bands: {math.verdict}",
            "",
            f"Write the {Advice.__name__} for this verdict. Express the tradeoff in something the "
            "user recognises — hours of work, or months of saving.",
        ]
    )

    advice, model = complete_structured_with_model(prompt, Advice, system=ADVICE_SYSTEM)
    return AssessResponse(
        item_name=request.item_name,
        category=request.category,
        price=request.price,
        currency=profile.currency,
        math=math,
        advice=advice,
        model=model,
    )
