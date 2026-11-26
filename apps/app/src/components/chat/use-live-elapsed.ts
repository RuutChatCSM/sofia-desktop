import * as React from "react"

/** Ticks while a turn is live so its header can show elapsed work time. */
export function useLiveElapsed(startedAt: number | null, active: boolean): number | null {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  if (startedAt === null || !active) return null
  return Math.max(0, now - startedAt)
}
