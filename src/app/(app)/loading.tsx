/**
 * Shown while a signed-in screen streams in.
 *
 * Every page here is a server component that reads several collections before
 * it can render — the dashboard alone makes 17 reads. Without this the app
 * showed the *previous* screen until the next one resolved, which reads as a
 * frozen click rather than a load.
 *
 * Deliberately a calm skeleton rather than a spinner: it holds the shape of a
 * page, so the layout does not jump when the real content arrives.
 */
export default function AppLoading() {
  return (
    <div className="mx-auto max-w-[1500px] animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="pb-5 pt-1">
        <div className="h-8 w-64 rounded-lg bg-[var(--panel)]" />
        <div className="mt-2 h-4 w-80 rounded bg-[var(--panel)]" />
      </div>

      <div className="grid grid-cols-1 gap-5 @min-[820px]:grid-cols-[minmax(0,1fr)_336px]">
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 @min-[620px]:grid-cols-2">
            <div className="card h-48" />
            <div className="card h-48" />
          </div>
          <div className="card h-64" />
        </div>
        <div className="flex flex-col gap-5">
          <div className="card h-40" />
          <div className="card h-72" />
        </div>
      </div>
    </div>
  );
}
