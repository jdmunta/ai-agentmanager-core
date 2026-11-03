// Autopilot: a backlog item's finished work goes on to a pull request, and merged, without you,
// when the review scorecard says it's ready. Set per project in the backlog:
//   off   - today's flow: the item waits in review for Accept or Reopen.
//   pr    - ready work is committed, pushed and opened as a pull request (scorecard in its description).
//   merge - and the pull request is merged once its checks pass and GitHub allows it (a branch that
//           fell behind is brought up to date first; failing checks go back to the agent through Landing).
// Work the scorecard finds not ready for a concrete reason (failing CI, criteria not met, barely
// verified) goes back to the agent with those reasons, a couple of times at most. Anything else
// ("look at these first", a failed step, a closed pull request) waits for you in the inbox, with
// Ship it to go ahead anyway. An item whose pull request merges is done.
import { RECOMMENDATION } from './scorecard.js';
import { landState } from './tracker.js';

export const AUTOPILOT_LEVELS = ['off', 'pr', 'merge'];
export const AUTOPILOT_LABEL = { off: 'Off', pr: 'Open pull requests', merge: 'Merge' };
const RETURNS = 2; // times not-ready work goes back to the agent before it waits for you

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });

/** The message that sends not-ready work back to its agent. */
export function returnMessage(sc) {
  const reasons = sc.reasons?.length ? sc.reasons.join('; ') : RECOMMENDATION[sc.recommendation];
  const notMet = (sc.criteria ?? []).filter((c) => c.status === 'not_met').map((c) => `- ${c.criterion}${c.evidence ? ` (${c.evidence})` : ''}`);
  return [`Autopilot: the review scorecard says this isn't ready yet: ${reasons}.`, notMet.length ? `Acceptance criteria not met:\n${notMet.join('\n')}` : '', 'Fix these and make sure the checks pass'].filter(Boolean).join('\n\n');
}

export class Autopilot {
  constructor({ manager, store, backlog, review, landing, config = {}, log = (m) => console.log(`[agentmgr] ${m}`) }) {
    Object.assign(this, { manager, store, backlog, review, landing, config, log });
    this.returns = config.autopilot?.returns ?? RETURNS;
    this.working = new Set(); // item ids with a step in progress
    this.queued = null;
    this.kick = () => this.schedule();
    manager.on('change', this.kick);
    manager.on('prs', this.kick);
    backlog.on('change', this.kick);
    this.timer = setInterval(this.kick, 30_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    this.manager.off('change', this.kick);
    this.manager.off('prs', this.kick);
    this.backlog.off('change', this.kick);
  }

  schedule() {
    if (this.queued) return;
    this.queued = setTimeout(() => {
      this.queued = null;
      this.tick().catch((e) => this.log(`autopilot: ${e.message}`));
    }, 250);
    this.queued.unref?.();
  }

  async tick() {
    for (const it of this.backlog.items()) {
      if (it.status !== 'review' || this.working.has(it.id)) continue;
      this.working.add(it.id);
      try {
        await this.step(it);
      } catch (e) {
        this.hold(it, e.message);
      } finally {
        this.working.delete(it.id);
      }
    }
  }

  /** Record where autopilot stands on an item (shown in the backlog), only when it changed. */
  note(it, patch) {
    const next = { ...it.autopilot, ...patch };
    if (JSON.stringify(next) === JSON.stringify(it.autopilot ?? {})) return;
    it.autopilot = { ...next, at: now() };
    this.backlog.changed();
  }

  /** Stop and wait for the person, for this round of review. */
  hold(it, why) {
    this.log(`autopilot: holding "${it.title}": ${why}`);
    this.note(it, { state: 'held', note: String(why).slice(0, 500), round: it.reviewAt });
  }

  /** One look at an item in review: what's the next thing autopilot can do for it? */
  async step(it) {
    const agent = it.agentId && this.store.get(it.agentId);
    if (!agent) return;
    const ap = it.autopilot ?? {};
    const pr = ap.pr ? agent.prs?.[ap.pr] : null;
    // Its pull request merged (by autopilot, by you or by GitHub's auto-merge): the item is done.
    if (pr?.state === 'MERGED') {
      this.note(it, { state: 'merged', note: null });
      this.backlog.accept(it.id);
      return;
    }
    const level = this.backlog.autopilotFor(it.projectKey);
    if (level === 'off' && !ap.ship) return;
    if (ap.state === 'held' && ap.round === it.reviewAt) return;
    if (this.manager.view(agent).runtime.busy) return;
    if (pr?.state === 'CLOSED') return this.hold(it, 'Its pull request was closed without merging.');
    // Shipped in this round of review: see it through. Reopened since: the new work is scored and pushed to it.
    if (pr && ap.shipped === it.reviewAt) return level === 'merge' ? this.land(it, agent, pr) : undefined;

    // Not shipped yet: the scorecard of the current changes decides (unless you said Ship it).
    const changes = await this.review.get(agent.id);
    if (!changes.files?.length) return this.hold(it, 'There are no changes to ship.');
    if (ap.ship) return this.ship(it, agent, level);
    const card = agent.docs?.scorecard;
    if (card?.pending) return;
    if (card?.diffHash !== changes.diffHash || !card?.data) {
      if (ap.scored === changes.diffHash) return this.hold(it, card?.error ? `Couldn't score the changes: ${card.error}` : "Couldn't score the changes.");
      this.note(it, { state: 'scoring', scored: changes.diffHash, note: null });
      await this.manager.summarize(agent.id, 'scorecard').catch((e) => {
        throw err(e.status, `Couldn't score the changes: ${e.message}`);
      });
      return this.schedule();
    }
    const sc = card.data;
    if (sc.recommendation === 'ready') return this.ship(it, agent, level);
    if (sc.recommendation === 'not_ready' && (ap.returns ?? 0) < this.returns) {
      this.note(it, { state: 'returned', returns: (ap.returns ?? 0) + 1, note: sc.reasons.join('; ') });
      this.backlog.reopen(it.id, { note: returnMessage(sc) });
      return;
    }
    const why = sc.recommendation === 'look' ? `The scorecard says to look first (${sc.overall ?? '?'}/100)${sc.look?.length ? `: ${sc.look.map((l) => l.file).join(', ')}` : ''}.` : `Still not ready after ${ap.returns ?? 0} tr${ap.returns === 1 ? 'y' : 'ies'}: ${sc.reasons.join('; ')}.`;
    this.hold(it, why);
  }

  /** Commit what's left, push and open the pull request; at "merge", landing takes it from there. */
  async ship(it, agent, level) {
    this.note(it, { state: 'shipping', note: null });
    const title = it.title.split('\n')[0].slice(0, 100);
    try {
      await this.review.commit(agent.id, { message: title });
    } catch (e) {
      if (e.status !== 409 || !/nothing to commit/i.test(e.message)) throw e;
    }
    const { url } = await this.review.pr(agent.id, { title });
    if (!url) throw err(502, 'Pushed, but no pull request link came back.');
    this.log(`autopilot: opened ${url} for "${it.title}"`);
    this.note(it, { state: level === 'merge' ? 'landing' : 'pr', pr: url, shipped: it.reviewAt, ship: false });
    await this.manager.refresh(agent.id, { withPrs: true }).catch(() => {});
  }

  /** At "merge": merge a ready pull request, update one that fell behind, wait out the rest. */
  async land(it, agent, pr) {
    const state = landState(pr);
    if (state === 'ready') {
      this.note(it, { state: 'merging' });
      await this.landing.merge(agent.id, { url: pr.url });
      this.log(`autopilot: merged ${pr.url}`);
      return;
    }
    if (state === 'behind' && it.autopilot.updated !== pr.head) {
      this.note(it, { state: 'landing', updated: pr.head });
      await this.landing.updateBranch(agent.id);
      return;
    }
    const fixes = Object.keys(agent.landing?.sent ?? {}).filter((k) => k.startsWith(`${pr.url}#`)).length;
    if (state === 'fix' && fixes >= this.landing.settings.maxFixes) return this.hold(it, `Its pull request still needs fixes after ${fixes} tries (checks, review or conflicts).`);
    if (state === 'draft') return this.hold(it, 'Its pull request is a draft.');
    this.note(it, { state: 'landing' });
  }

  /** "Ship it": go ahead with an item autopilot held (or one in review with autopilot off). */
  shipNow(id) {
    const it = this.backlog.get(id);
    if (it.status !== 'review') throw err(409, `Item is ${it.status}`);
    if (!it.agentId || !this.store.get(it.agentId)) throw err(409, 'The item has no agent');
    this.note(it, { state: 'queued', ship: true, round: null, scored: null, note: null });
    this.schedule();
    return it;
  }

  /** Held items, for the inbox. */
  inbox() {
    return this.backlog
      .items()
      .filter((it) => it.status === 'review' && it.autopilot?.state === 'held' && it.autopilot.round === it.reviewAt)
      .map((it) => ({ kind: 'autopilot', key: `autopilot:${it.id}`, title: it.title, itemId: it.id, agentId: it.agentId, project: it.projectName, priority: it.priority, note: it.autopilot.note, at: it.autopilot.at }));
  }
}
