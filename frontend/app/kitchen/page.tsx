const stages = ["New", "Cooking", "Ready", "Picked up"];

export default function KitchenPage() {
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold sm:text-3xl">Kitchen</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stages.map((stage) => (
          <section key={stage} className="flex flex-col gap-3">
            <div className="flex items-center justify-between border-b border-line pb-2">
              <h2 className="text-lg font-bold">{stage}</h2>
              <span className="rounded-full bg-line px-2 text-sm text-muted">0</span>
            </div>
            <p className="text-sm text-muted">No orders.</p>
          </section>
        ))}
      </div>
    </div>
  );
}
