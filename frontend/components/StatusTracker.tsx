import type { Order, OrderStatus } from "@/lib/types";

const steps: { status: OrderStatus; label: string; at: (o: Order) => string | null }[] = [
  { status: "NEW", label: "New", at: (o) => o.createdAt },
  { status: "COOKING", label: "Cooking", at: (o) => o.cookingAt },
  { status: "READY", label: "Ready", at: (o) => o.readyAt },
  { status: "PICKED_UP", label: "Picked up", at: (o) => o.pickedUpAt },
];

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function StatusTracker({ order }: { order: Order }) {
  const current = steps.findIndex((s) => s.status === order.status);

  return (
    <div className="flex flex-col gap-2">
      {order.status === "READY" && <p className="text-sm font-semibold text-brand-dark">Ready for pickup</p>}
      <ol className="grid grid-cols-4">
        {steps.map((step, i) => {
          const done = i <= current;
          const at = step.at(order);
          return (
            <li key={step.status} className="relative flex flex-col items-center gap-1 text-center">
              {i > 0 && (
                <span
                  className={`absolute top-[7px] right-1/2 h-0.5 w-full ${done ? "bg-brand" : "bg-line"}`}
                  aria-hidden
                />
              )}
              <span
                className={`relative size-4 rounded-full border-2 ${
                  i === current
                    ? "border-brand bg-brand ring-4 ring-brand/20"
                    : done
                      ? "border-brand bg-brand"
                      : "border-line bg-card"
                }`}
                aria-hidden
              />
              <span
                className={`text-xs ${i === current ? "font-semibold text-brand-dark" : done ? "text-ink" : "text-muted"}`}
                aria-current={i === current ? "step" : undefined}
              >
                {step.label}
              </span>
              <span className="text-[11px] text-muted tabular-nums">{done && at ? formatTime(at) : " "}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
