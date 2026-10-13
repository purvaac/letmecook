import type { Order, OrderStatus } from "@/lib/types";

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const steps: { status: OrderStatus; label: string; at: (o: Order) => string | null; icon: React.ReactNode }[] = [
  {
    status: "NEW",
    label: "Placed",
    at: (o) => o.createdAt,
    icon: (
      <Icon>
        <path d="M5 2v20l2-1.5L9 22l2-1.5L13 22l2-1.5L17 22l2-1.5V2l-2 1.5L15 2l-2 1.5L11 2 9 3.5 7 2 5 3.5Z" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </Icon>
    ),
  },
  {
    status: "COOKING",
    label: "Cooking",
    at: (o) => o.cookingAt,
    icon: (
      <Icon>
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
      </Icon>
    ),
  },
  {
    status: "READY",
    label: "Ready",
    at: (o) => o.readyAt,
    icon: (
      <Icon>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </Icon>
    ),
  },
  {
    status: "PICKED_UP",
    label: "Picked up",
    at: (o) => o.pickedUpAt,
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </Icon>
    ),
  },
];

const captions: Record<OrderStatus, string> = {
  NEW: "The kitchen has your order.",
  COOKING: "Your order is being cooked.",
  READY: "Ready for pickup",
  PICKED_UP: "Picked up. Enjoy your meal.",
};

function formatTime(iso: string) {
  return new Date(iso)
    .toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })
    .toLowerCase();
}

export default function StatusTracker({ order }: { order: Order }) {
  const current = steps.findIndex((s) => s.status === order.status);

  return (
    <div className="flex flex-col items-center gap-3">
      <ol className="grid w-full grid-cols-4">
        {steps.map((step, i) => {
          const reached = i <= current;
          const at = step.at(order);
          return (
            <li key={step.status} className="relative flex flex-col items-center text-center">
              {i > 0 && (
                <span
                  className={`absolute top-[17px] right-1/2 z-0 h-0.5 w-full ${reached ? "bg-brand" : "bg-line"}`}
                  aria-hidden
                />
              )}
              <span
                className={`relative z-10 flex size-9 items-center justify-center rounded-full border-2 ${
                  reached ? "border-brand bg-brand text-ink" : "border-line bg-card text-muted"
                } ${i === current ? "shadow-[0_0_10px_3px_rgb(57_255_136/0.55)] motion-safe:animate-glow" : ""}`}
              >
                {step.icon}
              </span>
              <span
                className={`mt-1.5 text-xs ${i === current ? "font-semibold text-ink" : reached ? "text-ink" : "text-muted"}`}
                aria-current={i === current ? "step" : undefined}
              >
                {step.label}
              </span>
              <span className="text-[11px] text-muted tabular-nums">{reached && at ? formatTime(at) : "—"}</span>
            </li>
          );
        })}
      </ol>
      <p className={`text-sm ${order.status === "READY" ? "font-semibold text-brand-dark" : "text-ink"}`}>
        {captions[order.status]}
      </p>
    </div>
  );
}
