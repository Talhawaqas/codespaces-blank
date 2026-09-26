import { redirect } from "next/navigation";

// /support/<portal address> is the short, shareable form of /portal/<portal address>.
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function SupportShortLink({ params }) {
  const { slug } = await params;
  redirect(`/portal/${encodeURIComponent(String(slug).toLowerCase())}`);
}
