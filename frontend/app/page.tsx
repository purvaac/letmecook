export default function CustomerPage() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <section>
        <h1 className="mb-4 text-2xl font-bold sm:text-3xl">Menu</h1>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-lg border border-line bg-card p-4 text-sm text-muted">Menu items will appear here.</div>
        </div>
      </section>

      <aside className="flex flex-col gap-6">
        <section className="rounded-lg border border-line bg-card p-4">
          <h2 className="mb-2 text-lg font-bold">Your cart</h2>
          <p className="text-sm text-muted">Your cart is empty.</p>
        </section>
        <section className="rounded-lg border border-line bg-card p-4">
          <h2 className="mb-2 text-lg font-bold">Your orders</h2>
          <p className="text-sm text-muted">No orders yet.</p>
        </section>
      </aside>
    </div>
  );
}
