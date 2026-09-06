"use client";

import { useEffect, useState } from "react";

/**
 * Whether pressing Call could plausibly do anything.
 *
 * `tel:` and `sms:` are handoffs. On a phone they open the dialler and the
 * messages app; on a desktop they open whatever the operating system has
 * registered for them, which is usually nothing — the click is swallowed, no
 * window appears, and the button reads as broken. Reported exactly that way:
 * "doesn't work". Worse than the silence, the CRM recorded an outreach for a
 * call that never happened.
 *
 * The test is for a device's INPUT capability, not its name. A coarse pointer
 * with no hover is a touchscreen, and a touchscreen in this product's hands is
 * a phone or a tablet — both of which really do have a dialler. User-agent
 * sniffing would be the other way to ask, and it is wrong every time a browser
 * changes its string.
 *
 * Defaults to `false` so the server and the first client render agree, then
 * corrects on mount. Being briefly wrong in the safe direction costs nothing:
 * the desktop treatment shows the number, which is useful on a phone too.
 */
export function useCanDial(): boolean {
  const [canDial, setCanDial] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(hover: none) and (pointer: coarse)");
    const sync = () => setCanDial(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return canDial;
}
