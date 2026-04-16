import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { PropsWithChildren } from "react";
import { CrmShell } from "../../components/crm-shell";
import { fetchCurrentActorServer } from "../../lib/auth-api";

export default async function AppLayout({ children }: PropsWithChildren) {
  const actor = await fetchCurrentActorServer(cookies().toString());
  if (!actor) {
    redirect("/login");
  }

  return <CrmShell actor={actor}>{children}</CrmShell>;
}
