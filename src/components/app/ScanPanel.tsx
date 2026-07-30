// Photograph a thing, find out whether this month can carry it.
//
// Three steps, each visible on its own: the shot, what the model read out of it, then the
// verdict. Deliberately not chained into one tap. Seeing "AirPods Pro, about 329" before a
// second model call is spent is the moment the user learns whether to trust the answer, and
// it is where they get to correct a wrong price instead of arguing with the result.
//
// The viewfinder is built here rather than taken from the camera module's own component,
// because that one ships its own palette and would not match anything around it. The hook
// underneath is the module's, and it is where every real trap lives: no HTTPS, denied
// permission, a camera another app is holding, constraints the device cannot meet.

import { Camera01, Image01, RefreshCw01, XClose } from '@untitledui/icons';
import { useEffect, useRef, useState } from 'react';
import { VerdictCard } from '@/components/app/VerdictCard';
import { useCameraPhoto } from '@/lib/camera/useCameraPhoto';
import { matchVision } from '@/lib/vision/visionTypes';
import { useVision } from '@/lib/vision/useVision';
import { fetchJson, useAsync } from '@/lib/ui-states/useAsync';
import type { AssessRequest, AssessResponse, BudgetResponse, ItemReading } from '@/types/contract';

/** Share of spare money this purchase is allowed to claim, and the buffer left untouched. */
const COMMIT_SHARE = 0.3;
const EMERGENCY_MONTHS = 1;

function assess(signal: AbortSignal, request: AssessRequest): Promise<AssessResponse> {
  return fetchJson<AssessResponse>('/api/affordability/assess', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
    timeoutMs: 90_000,
  });
}

export function ScanPanel({ budget }: { budget: BudgetResponse }) {
  const camera = useCameraPhoto({ autoStart: false });
  const vision = useVision<ItemReading>({ schemaName: 'item' });
  const verdict = useAsync<AssessResponse, [AssessRequest]>(assess);

  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [price, setPrice] = useState('');

  // A blob URL that outlives its preview is a leak, and on a phone that is real memory.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const accept = (blob: Blob) => {
    setShot((previous) => {
      if (previous) URL.revokeObjectURL(previous.url);
      return { blob, url: URL.createObjectURL(blob) };
    });
    setPrice('');
    verdict.reset();
    camera.stop();
    void vision.extract(blob, { schemaName: 'item' });
  };

  const clear = () => {
    setShot((previous) => {
      if (previous) URL.revokeObjectURL(previous.url);
      return null;
    });
    setPrice('');
    vision.reset();
    verdict.reset();
  };

  const check = (reading: ItemReading, tested: number) => {
    void verdict.run({
      profile: {
        monthly_income: budget.monthly_income,
        monthly_expenses: budget.spent,
        savings: budget.savings,
        currency: budget.currency,
        commit_share: COMMIT_SHARE,
        emergency_months: EMERGENCY_MONTHS,
      },
      item_name: reading.name,
      category: reading.category,
      price: tested,
      price_basis: reading.price_basis,
    });
  };

  return (
    <section
      aria-label="Scan an object"
      className="flex flex-col gap-4 rounded-2xl border border-secondary bg-primary p-4 shadow-xs"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Can I afford this?</h2>
          <p className="mt-0.5 text-sm text-tertiary">
            Point the camera at it, or pick a photo. Checked against the{' '}
            {new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(budget.leftover)}{' '}
            {budget.currency} you have spare each month.
          </p>
        </div>
        {shot && (
          <button
            type="button"
            onClick={clear}
            aria-label="Discard this photo"
            className="grid size-8 shrink-0 place-items-center rounded-full text-tertiary transition hover:bg-primary_hover hover:text-secondary"
          >
            <XClose className="size-4" />
          </button>
        )}
      </header>

      {shot ? (
        <img
          src={shot.url}
          alt="The object you photographed"
          className="max-h-72 w-full rounded-xl border border-secondary object-contain"
        />
      ) : (
        <Viewfinder camera={camera} onCapture={accept} onPick={accept} />
      )}

      {shot &&
        matchVision(vision.extraction, {
          idle: () => null,
          loading: () => <Reading label="Reading the photo" />,
          error: (error) => (
            <Failure message={error.message} onRetry={() => void vision.retryExtract()} />
          ),
          unsupported: ({ reason, hint }) => <Failure message={`${reason} ${hint}`} />,
          ready: ({ result, model }) => {
            // A model that cannot price what it sees returns 0 rather than inventing a
            // number, which is the behaviour we want. The button must then wait for a real
            // price instead of sending 0 and collecting a validation error.
            const typed = Number(price);
            const tested = typed > 0 ? typed : result.estimated_price;
            return (
              <ItemFound
                reading={result}
                model={model}
                currency={budget.currency}
                price={price}
                onPriceChange={setPrice}
                tested={tested}
                pending={verdict.state.status === 'loading'}
                onCheck={() => check(result, tested)}
              />
            );
          },
        })}

      {verdict.state.status === 'loading' && <Reading label="Working out what it costs you" />}
      {verdict.state.status === 'error' && (
        <Failure message={verdict.state.error.message} onRetry={() => void verdict.retry()} />
      )}
      {verdict.state.status === 'success' && <VerdictCard data={verdict.state.data} />}
    </section>
  );
}

function Viewfinder({
  camera,
  onCapture,
  onPick,
}: {
  camera: ReturnType<typeof useCameraPhoto>;
  onCapture: (blob: Blob) => void;
  onPick: (blob: Blob) => void;
}) {
  const [captureError, setCaptureError] = useState<string | null>(null);

  const take = async () => {
    setCaptureError(null);
    try {
      onCapture(await camera.capture());
    } catch (thrown) {
      setCaptureError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {camera.status === 'ready' || camera.starting ? (
        <div className="relative overflow-hidden rounded-xl bg-secondary">
          {/* playsInline and muted are both required, or iOS Safari opens this fullscreen. */}
          <video
            ref={camera.videoRef}
            playsInline
            muted
            autoPlay
            className="aspect-[4/3] w-full object-cover"
          />
          {camera.starting && (
            <p className="absolute inset-0 grid place-items-center text-sm text-tertiary">
              Starting the camera
            </p>
          )}
        </div>
      ) : (
        <div className="grid aspect-[4/3] w-full place-items-center rounded-xl border border-dashed border-secondary bg-secondary px-6 text-center">
          {camera.error ? (
            <div>
              <p className="text-sm text-error-primary">{camera.error.message}</p>
              <p className="mt-1 text-sm text-tertiary">{camera.error.hint}</p>
            </div>
          ) : (
            <p className="text-sm text-tertiary">
              {camera.supported ? 'The camera is off.' : 'This browser cannot open a camera here.'}
            </p>
          )}
        </div>
      )}

      {captureError && <p className="text-sm text-error-primary">{captureError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {camera.status === 'ready' ? (
          <button
            type="button"
            onClick={() => void take()}
            disabled={camera.capturing}
            className="flex items-center gap-2 rounded-full bg-brand-solid px-4 py-2.5 text-sm font-medium text-primary_on-brand transition hover:bg-brand-solid_hover active:scale-[0.98] disabled:opacity-40"
          >
            <Camera01 className="size-4" />
            {camera.capturing ? 'Taking it' : 'Take the photo'}
          </button>
        ) : (
          camera.supported && (
            <button
              type="button"
              onClick={camera.error ? camera.retry : camera.start}
              className="flex items-center gap-2 rounded-full bg-brand-solid px-4 py-2.5 text-sm font-medium text-primary_on-brand transition hover:bg-brand-solid_hover active:scale-[0.98]"
            >
              {camera.error ? <RefreshCw01 className="size-4" /> : <Camera01 className="size-4" />}
              {camera.error ? 'Try the camera again' : 'Open the camera'}
            </button>
          )
        )}

        {/* Two inputs, not one: `capture` forces the camera app and silently disables the
            library, which is exactly wrong when the camera is the thing that failed. */}
        <FilePick label="Photo library" onPick={onPick} />
        {!camera.supported && <FilePick label="Camera app" capture onPick={onPick} />}
      </div>
    </div>
  );
}

function FilePick({
  label,
  capture,
  onPick,
}: {
  label: string;
  capture?: boolean;
  onPick: (blob: Blob) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex items-center gap-2 rounded-full border border-secondary px-4 py-2.5 text-sm text-secondary transition hover:bg-primary_hover active:scale-[0.98]"
      >
        <Image01 className="size-4" />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        {...(capture ? { capture: 'environment' as const } : {})}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.target.value = ''; // so picking the same file twice still fires
        }}
      />
    </>
  );
}

function ItemFound({
  reading,
  model,
  currency,
  price,
  onPriceChange,
  tested,
  pending,
  onCheck,
}: {
  reading: ItemReading;
  model: string;
  currency: string;
  price: string;
  onPriceChange: (value: string) => void;
  /** The price the verdict would actually use: what was typed, else the model's estimate. */
  tested: number;
  pending: boolean;
  onCheck: () => void;
}) {
  const unpriced = reading.estimated_price <= 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-secondary p-3">
      <div>
        <p className="text-md font-medium">
          {reading.brand ? `${reading.brand} ${reading.name}` : reading.name}
        </p>
        <p className="mt-0.5 text-sm text-tertiary">
          {reading.category} · {reading.condition}
          {!unpriced && ` · ${Math.round(reading.price_confidence * 100)}% sure of the price`}
        </p>
      </div>

      <p className="text-sm text-tertiary">{reading.price_basis}</p>

      <label className="flex flex-wrap items-end gap-2">
        <span className="flex flex-col gap-1.5">
          <span className="text-xs text-tertiary">
            {unpriced ? `What does it cost? (${currency})` : `Price to test (${currency})`}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={price}
            placeholder={unpriced ? 'e.g. 329' : String(Math.round(reading.estimated_price))}
            onChange={(event) => onPriceChange(event.target.value)}
            /* text-base on a phone: iOS Safari zooms in on a focused input under 16px. */
            className="w-32 rounded-xl border border-secondary bg-primary px-3 py-2 text-base tabular-nums text-primary transition placeholder:text-placeholder focus:border-brand focus:outline-none sm:text-sm"
          />
        </span>
        <button
          type="button"
          onClick={onCheck}
          disabled={pending || tested <= 0}
          className="rounded-full bg-brand-solid px-4 py-2.5 text-sm font-medium text-primary_on-brand transition hover:bg-brand-solid_hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Checking' : 'Can I afford it?'}
        </button>
      </label>

      <p className="text-xs text-quaternary">
        {unpriced
          ? `${model} would not put a price on this one, and it does not guess. Type what it costs and the verdict is exact.`
          : `Read by ${model}. Change the price if it guessed wrong; the verdict uses what is in the box.`}
      </p>
    </div>
  );
}

function Reading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 rounded-xl bg-secondary px-3 py-3">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-1.5 animate-bounce rounded-full bg-fg-quaternary"
          style={{ animationDelay: `${dot * 120}ms` }}
        />
      ))}
      <span className="text-sm text-tertiary">{label}</span>
    </div>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-error_subtle bg-error-primary px-3 py-3">
      <p className="text-sm text-error-primary">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-lg border border-error_subtle px-2.5 py-1 text-xs text-error-primary transition hover:bg-error-secondary"
        >
          Try again
        </button>
      )}
    </div>
  );
}
