// PRD-SPARKS closure §4 — the "+⚡ for publishing!" card on the publish done
// screen. Purely presentational (amount in, markup out) so it render-tests
// with ReactDOMServer and PublishToArcade only decides WHETHER to show it.

export default function SparksCelebrationCard({ amount }: { amount: number }) {
  return (
    <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-center">
      <div className="text-2xl">⚡</div>
      <div className="text-sm font-extrabold text-amber-700">+{amount.toLocaleString("en-IN")} ⚡ for publishing!</div>
      <div className="mt-0.5 text-[11px] text-amber-600">Added to your Sparks — see them in your Wallet.</div>
    </div>
  );
}
