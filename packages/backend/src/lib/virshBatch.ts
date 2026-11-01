// Several read-only virsh commands in one process. Starting virsh is most of what a read costs,
// about 40 ms against about 3 ms a command once connected, and the dashboard asks about every VM
// on a timer.
//
// Measured on libvirt 10.0 and 11.3: a command that fails prints to stderr only and virsh goes on
// to the next, with an exit status that says only how the last one went. So each answer has a
// marker in front of it, and one is only taken whole, with the next marker after it.

// virsh splits the string again itself, on spaces, semicolons, quotes and more. Nothing goes in
// that isn't plainly one word, or an argument from outside could add a command of its own.
const WORD = /^[A-Za-z0-9._:-]+$/;

export function isBatchWord(arg: string): boolean {
  return WORD.test(arg);
}

export function buildVirshBatch(commands: ReadonlyArray<readonly string[]>, mark: string): string {
  const parts = commands.flatMap((command, i) => {
    for (const arg of command) {
      if (!isBatchWord(arg)) throw new Error(`Refusing to put "${arg}" in a virsh batch`);
    }
    return [`echo ${mark}:${i}`, command.join(' ')];
  });
  return [...parts, `echo ${mark}:end`].join(' ; ');
}

/**
 * One answer per command, null where it printed nothing, which every command used here does only
 * on failure, and null for any virsh never finished: killed part of the way through a table, it
 * would otherwise read as a VM with fewer NICs than it has.
 */
export function splitVirshBatch(stdout: string, mark: string, count: number): Array<string | null> {
  const answers: Array<string | null> = new Array(count).fill(null);
  let at = -1;
  let held: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(`${mark}:`)) {
      held.push(line);
      continue;
    }
    if (at >= 0) answers[at] = held.join('\n').trim() || null;
    held = [];
    const which = line.slice(mark.length + 1);
    at = which === 'end' ? -1 : Number(which);
  }
  return answers;
}
