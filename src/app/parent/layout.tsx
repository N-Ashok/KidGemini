// Grown-up page: normal scrolling document, so the Ariantra footer belongs
// here (the chat screen deliberately has none — see root layout).
import { ArFooter } from "@/components/ArFooter";

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ArFooter />
    </>
  );
}
