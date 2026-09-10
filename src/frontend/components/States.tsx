/** Shared loading / error / empty presentation. */

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="state state--loading" role="status">
      {label}
    </p>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <p className="state state--error" role="alert">
      {message}
    </p>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="empty">{message}</p>;
}
