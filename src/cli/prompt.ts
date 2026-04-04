import { createInterface } from 'node:readline';

const rl = () =>
  createInterface({ input: process.stdin, output: process.stdout });

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const r = rl();
  return new Promise((resolve) => {
    r.question(`${question}${suffix}: `, (answer) => {
      r.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const r = rl();
  return new Promise((resolve) => {
    r.question(`${question} (${hint}): `, (answer) => {
      r.close();
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

export async function select(question: string, options: { label: string; value: string }[]): Promise<string> {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]!.label}`);
  }
  const r = rl();
  return new Promise((resolve) => {
    r.question(`Choose (1-${options.length}): `, (answer) => {
      r.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx]!.value);
      } else {
        resolve(options[0]!.value);
      }
    });
  });
}
