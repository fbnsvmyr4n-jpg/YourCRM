"use client";

import { useState } from "react";

/**
 * A form that is folded away until asked for, and folds itself back once it has
 * worked.
 *
 * Two forms on Settings want this — inviting a colleague, and changing a
 * password — and both are things somebody does rarely, whose empty fields would
 * otherwise occupy the screen on every visit for everybody who came to do
 * something else.
 *
 * The awkward half is closing on success. The obvious version watches the
 * action's result in an effect and calls `setOpen(false)`, which is a cascading
 * render and exactly what the React compiler rejects. So it is derived instead:
 * the form is open unless the CURRENT result is a success this hook has not
 * already been reopened past. `open()` records the result it opened over, which
 * makes that success old news and the form open again — no effect, no
 * synchronising, and nothing to get out of step.
 *
 * The result itself keeps showing while closed. A fold that swallows the answer
 * to the thing it just did is worse than no fold.
 *
 * @param state the action state, whatever shape it has
 * @param succeeded whether that state represents a completed action
 */
export function useFormDisclosure<T>(
  state: T,
  succeeded: (state: T) => boolean
): readonly [boolean, () => void, () => void] {
  const [requested, setRequested] = useState(false);
  /* Identity, not value: two consecutive successes are two different objects,
     so a second invitation closes the form again. */
  const [consumed, setConsumed] = useState<T | null>(null);

  const isOpen = requested && !(succeeded(state) && state !== consumed);

  const open = () => {
    setRequested(true);
    setConsumed(state);
  };
  const close = () => setRequested(false);

  return [isOpen, open, close] as const;
}
