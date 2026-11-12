import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_FILES, type DatasetName } from './datasets.js';

/**
 * Re-downloads the benchmark files into data/benchmarks/ (git-ignored; the data is never committed) and
 * prints each file's sha256. It is a command for a person to run; tests never call it.
 *
 *   SimpleQA     https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv
 *                MIT (openai/simple-evals). The grader source simpleqa_eval.py is fetched too, so the grader
 *                prompt used here can be checked against it.
 *   FreshQA      the April 21, 2026 release: a Google Sheet linked from the github.com/freshllms/freshqa
 *                README, exported as CSV. Apache-2.0. The sheet's export URL is not fixed in this
 *                repository: pass it with --freshqa-url (or FRESHQA_CSV_URL), or save the CSV by hand.
 *   LongMemEval  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned (longmemeval_oracle.json). MIT.
 */

export interface Download {
  dataset: DatasetName;
  url: string;
  file: string;
  licence: string;
}

export const SIMPLEQA_GRADER_SOURCE = {
  url: 'https://raw.githubusercontent.com/openai/simple-evals/main/simpleqa_eval.py',
  file: 'data/benchmarks/simpleqa/simpleqa_eval.py',
};

export function downloads(freshQaUrl: string | undefined): Download[] {
  const list: Download[] = [
    {
      dataset: 'simpleqa',
      url: 'https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv',
      file: DATA_FILES.simpleqa,
      licence: 'MIT (openai/simple-evals)',
    },
    {
      dataset: 'longmemeval',
      url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
      file: DATA_FILES.longmemeval,
      licence: 'MIT (xiaowu0162/LongMemEval)',
    },
  ];
  if (freshQaUrl !== undefined) {
    list.push({
      dataset: 'freshqa',
      url: freshQaUrl,
      file: DATA_FILES.freshqa,
      licence: 'Apache-2.0 (freshllms/freshqa)',
    });
  }
  return list;
}

async function fetchTo(url: string, file: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function downloadAll(options: {
  only?: DatasetName;
  freshQaUrl?: string;
  log?: (line: string) => void;
}): Promise<void> {
  const log = options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  for (const d of downloads(options.freshQaUrl)) {
    if (options.only !== undefined && d.dataset !== options.only) continue;
    const sha = await fetchTo(d.url, d.file);
    log(`${d.dataset}: ${d.file} sha256 ${sha} (${d.licence})`);
  }
  if (options.only === undefined || options.only === 'simpleqa') {
    const sha = await fetchTo(SIMPLEQA_GRADER_SOURCE.url, SIMPLEQA_GRADER_SOURCE.file);
    log(`simpleqa grader source: ${SIMPLEQA_GRADER_SOURCE.file} sha256 ${sha} (MIT)`);
  }
  if (
    options.freshQaUrl === undefined &&
    (options.only === undefined || options.only === 'freshqa')
  ) {
    log(
      `freshqa: not downloaded. Open the FreshQA sheet linked from https://github.com/freshllms/freshqa, export the April 21, 2026 tab as CSV and save it as ${DATA_FILES.freshqa}, or pass --freshqa-url with the sheet's CSV export URL.`,
    );
  }
}
