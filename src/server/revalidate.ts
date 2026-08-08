import { revalidatePath } from "next/cache";

/**
 * Refresh every screen in the app group after a write.
 *
 * Actions used to revalidate only their own page, which meant adding a lead on
 * /leads left the dashboard's Today's Focus counts showing the previous
 * numbers until a hard reload — the staleness reported in user testing. The
 * shared layout has the same problem now that the notification bell lives
 * there: a write anywhere changes what the bell should say.
 *
 * Revalidating the *layout* covers the group and everything nested in it in
 * one call. Note the path is `/(app)`, not `/` — `revalidatePath("/")` inside
 * an action navigates the user to the home page mid-interaction, which has
 * bitten this codebase twice.
 */
export function revalidateApp(): void {
  revalidatePath("/(app)", "layout");
}
