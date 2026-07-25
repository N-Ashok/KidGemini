// Normal scrolling document (like /assets and /upgrade), so the Ariantra
// footer belongs here — the chat screen deliberately has none.
import { ArFooter } from "@/components/ArFooter";

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ArFooter />
    </>
  );
}
