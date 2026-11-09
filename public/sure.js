// Sure to merge: a pull request whose agent's Eval backs it all the way. The daemon merges on it
// (when that is turned on) and the Land tab lists these first, so both use this one rule.

/**
 * Whether a pull request can be merged on the strength of its agent's Eval: { sure, why }. Sure
 * means 100%, with the tests run by the app on the very commit the PR is at and nothing left
 * uncommitted, a reviewer's approval (unless that's turned off), and GitHub ready to merge it.
 */
export function sureToMerge(agent, pr, { needApproval = true, land = pr?.land } = {}) {
  const ev = agent?.eval;
  const no = (why) => ({ sure: false, why });
  if (!ev?.items) return no('No Eval yet');
  if (ev.rerun?.running) return no('Its tests are running');
  if (ev.confidence !== 100) return no(`The Eval is ${ev.confidence}%`);
  if (!ev.rerun?.passed) return no("The app's own test run didn't pass");
  if (!pr?.head || ev.rerun.head !== pr.head) return no('The tests ran on a different commit than the pull request is at');
  if (ev.rerun.clean === false) return no('There were uncommitted changes when the tests ran');
  if (needApproval && pr.review !== 'APPROVED') return no('No reviewer has approved it');
  if (land !== 'ready') return no(`GitHub doesn't have it ready to merge (${land ?? 'unknown'})`);
  return { sure: true, why: needApproval ? '100% on its latest commit, approved and ready' : '100% on its latest commit and ready' };
}
