import fs from 'node:fs';
import path from 'node:path';
import type { NormalizedJiraTicket } from './JiraTicketNormalizer';
import { db } from '../../../db/client';
import { jiraTickets, runs } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export class JiraOutputWriter {
  async writeToDB(runId: string, tickets: NormalizedJiraTicket[]): Promise<void> {
    for (const ticket of tickets) {
      await db.insert(jiraTickets).values({
        runId,
        issueKey: ticket.issueKey,
        source: ticket.source,
        normalizedTicket: ticket,
      }).onConflictDoNothing();
    }

    await db.update(runs)
      .set({
        recordsOut: tickets.length,
        status: 'success',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.runId, runId));
  }

  async writeToFile(
    client: string,
    reportMonth: string,
    tickets: NormalizedJiraTicket[]
  ): Promise<string> {
    const outputDir = path.resolve(process.cwd(), '../../output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filePath = path.join(outputDir, `${client}_jira_data.json`);
    const payload = {
      client,
      reportMonth,
      fetchedAt: new Date().toISOString(),
      tickets: tickets.map(t => ({
        ...t,
        created: t.created.toISOString(),
        updated: t.updated.toISOString(),
        resolved: t.resolved?.toISOString() ?? null,
        worklogs: t.worklogs.map(w => ({
          ...w,
          started: w.started.toISOString(),
        })),
      })),
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return filePath;
  }
}
