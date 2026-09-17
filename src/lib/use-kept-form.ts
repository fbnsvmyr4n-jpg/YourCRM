"use client";

import { startTransition, useActionState, useCallback, useEffect, useRef } from "react";

/**
 * A form backed by a server action that keeps what was typed when the save is
 * refused.
 *
 * React 19 resets every uncontrolled field once a `<form action={…}>` action
 * finishes — whether it succeeded or not. So a save the server refused ("{{frist_name}}
 * is not a field", "A choice list needs at least one choice") came back with
 * the error AND an empty form: the name typed a moment ago was gone, and on a
 * required field the browser then silently blocked the retry. Found on 18 Sep
 * 2026 while driving templates, and confirmed on the existing custom-field form.
 *
 * This submits through `onSubmit` instead, which React does not reset, and
 * clears the form itself only after a save that worked.
 *
 *   const { state, pending, formProps } = useKeptForm(saveAction, undefined);
 *   <form {...formProps}>…</form>
 *
 * One submit handler may serve many forms — a status control on every row —
 * so the form cleared is the one that was submitted, not a fixed one.
 */
export function useKeptForm<S>(
  action: (prev: S, formData: FormData) => Promise<S>,
  initial: S
) {
  const submitted = useRef<HTMLFormElement | null>(null);
  const [state, dispatch, pending] = useActionState<S, FormData>(
    action as (prev: Awaited<S>, formData: FormData) => Promise<S>,
    initial as Awaited<S>
  );

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      /* The button pressed travels with the data, as it would natively. */
      const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
      submitted.current = event.currentTarget;
      const data = new FormData(event.currentTarget, submitter);
      startTransition(() => dispatch(data));
    },
    [dispatch]
  );

  /* Clear only after a save that worked. */
  useEffect(() => {
    if (state && !(state as { error?: unknown }).error) submitted.current?.reset();
  }, [state]);

  return { state, pending, onSubmit, formProps: { onSubmit } };
}
