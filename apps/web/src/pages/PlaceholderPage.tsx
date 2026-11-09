import { EmptyState } from "../components/States";

export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
  return (
    <>
      <h1>{title}</h1>
      <div className="card">
        <EmptyState title="Em breve">Esta área será liberada na {phase}.</EmptyState>
      </div>
    </>
  );
}
