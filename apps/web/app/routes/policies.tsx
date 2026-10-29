import { redirect } from "react-router";

/** Council policies live on the Bylaws & policies page, under its Policies tab. */
export function loader() {
  return redirect("/bylaws?view=policies", 301);
}

export default function PoliciesRedirect() {
  return null; // Never rendered due to redirect
}
