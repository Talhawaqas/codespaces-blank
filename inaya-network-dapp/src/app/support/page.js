import SupportFinder from "../../components/portal/SupportFinder";

export const metadata = {
  alternates: { canonical: "/support" }, title: "Get support", description: "Find a company's customer support portal, open a request and follow it." };

export default function SupportPage() {
  return <SupportFinder />;
}
