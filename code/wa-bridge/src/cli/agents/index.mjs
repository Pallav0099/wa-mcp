// Agent integrations (filled in by M4). For now `wa connect` only points at the next step.

export async function offerAgents(flags, { line }) {
  line('Next: add WhatsApp to your agents with: wa agents add all');
  return 0;
}
