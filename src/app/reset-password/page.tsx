import { peekResetToken } from "@/server/password-reset-repo";
import { ResetPasswordView } from "./ResetPasswordView";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  // Validated before rendering so an expired link says so immediately rather
  // than after the user has typed a new password twice.
  const claim = token ? await peekResetToken(token) : null;

  return <ResetPasswordView token={token ?? ""} email={claim?.email ?? null} valid={!!claim} />;
}
