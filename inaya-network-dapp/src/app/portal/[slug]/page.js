import PortalApp from "../../../components/portal/PortalApp";

// Customer portals are for customers of one organization: never indexed, never cached.
export const metadata = { title: "Support portal", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PortalPage({ params }) {
  const { slug } = await params;
  return <PortalApp slug={slug} />;
}
