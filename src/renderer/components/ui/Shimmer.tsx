/**
 * Text with a light sweeping across it ("Working", "Thinking"). Drawn as a bright copy of the text
 * under a gradient mask that slides one way while the copy slides back the other, so the text
 * stands still and only the light moves. Both are transforms, which the compositor animates
 * without repainting: a sweep painted on the main thread would re-layer the whole page every frame.
 */
export function Shimmer({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className ? `shimmer ${className}` : "shimmer"}>
      {text}
      <span className="shimmer-light" aria-hidden>
        <span>{text}</span>
      </span>
    </span>
  );
}
