// Keep the server reference available without interrupting the actionable explanation.
export function ErrorNotice({ text, id }: { text: string; id?: string }) {
  const reference = /\s*\(Request: ([^)]+)\)/.exec(text);
  return <div role="alert" id={id}><p>{text.replace(/\s*\(Request: [^)]+\)/g, '')}</p>
    {reference ? <details className="diagnostics"><summary>Technical error details</summary><p>Request: {reference[1]}</p></details> : null}
  </div>;
}
