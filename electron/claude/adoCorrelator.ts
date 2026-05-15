import type { AdoItemRef, SessionMeta } from '@shared/claudeTypes'

export function buildJournalPayload(
  sessions: SessionMeta[],
  summaries: string[],
  adoItems: AdoItemRef[]
): string {
  const sessionBlock = sessions
    .map((s, i) => {
      const summary = summaries[i] ?? '(no summary)'
      return `## Session ${i + 1} — ${s.projectKey}
- Started: ${s.startedAt}
- Turns: ${s.turnCount}
- Models: ${s.models.join(', ')}
- First prompt: ${s.firstUserPrompt}

Summary:
${summary}
`.trim()
    })
    .join('\n\n')

  const adoBlock =
    adoItems.length === 0
      ? '(no ADO items modified today)'
      : adoItems
          .map(
            (it) =>
              `- #${it.id} ${it.workItemType} — ${it.title} (${it.state}, updated ${it.lastUpdated})`
          )
          .join('\n')

  return `# Sessions\n\n${sessionBlock || '(no sessions today)'}\n\n# ADO Items\n\n${adoBlock}\n`
}
