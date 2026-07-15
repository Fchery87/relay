export function RelayBrand() {
  return (
    <div aria-label="Relay" className="relay-brand" role="img">
      <svg aria-hidden="true" data-relay-mark="switchboard" viewBox="0 0 28 28">
        <path className="relay-mark-rail" d="M5 24V4h9.25c4.5 0 7.25 2.2 7.25 6s-2.75 6-7.25 6H5" />
        <path className="relay-mark-contact" d="m14.25 16 7.5 8" />
        <rect className="relay-mark-terminal" height="4" rx="0.75" width="4" x="3" y="2" />
        <rect className="relay-mark-terminal" height="4" rx="0.75" width="4" x="19.5" y="8" />
        <circle className="relay-mark-terminal" cx="21.75" cy="24" r="2" />
      </svg>
      <span>Relay</span>
    </div>
  );
}
