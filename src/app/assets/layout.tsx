// Normal scrolling document (like /upgrade), so the Ariantra footer belongs
// here — the chat screen deliberately has none (see root layout).
import { ArFooter } from "@/components/ArFooter";

export default function AssetsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ArFooter />
    </>
  );
}
