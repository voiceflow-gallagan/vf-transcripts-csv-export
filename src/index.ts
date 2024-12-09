import express from 'express';
import type { Request, Response } from 'express';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { fetch } from 'bun';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join, basename } from 'path';
import rateLimit from 'express-rate-limit';
import timeout from 'connect-timeout';
import { isISO8601 } from 'validator';
import { timingSafeEqual } from 'crypto';

const API_BASE_URL = Bun.env.API_BASE_URL;
const PROJECT_ID = Bun.env.PROJECT_ID;
const VF_API_KEY = Bun.env.VF_API_KEY;
const AUTHORIZATION_TOKEN = Bun.env.AUTHORIZATION_TOKEN;
const DELAY = parseInt(Bun.env.DELAY || '250');
const TIMEOUT = Bun.env.TIMEOUT || '5m';
const EXTRA_LOGS = Bun.env.EXTRA_LOGS || false;
const REDACT_API_URL = Bun.env.REDACT_API_URL || '';
const USE_REDACT = Bun.env.USE_REDACT || 'false';
const PORT = Bun.env.PORT || 3000;

// Rate limit configuration
const rateLimitWindowMs = parseInt(Bun.env.RATE_LIMIT_WINDOW_MS || '60000'); // 1 minute default
const rateLimitMaxRequests = parseInt(Bun.env.RATE_LIMIT_MAX_REQUESTS || '10'); // 10 requests default

const limiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max: rateLimitMaxRequests,
  message: 'Too many requests, please try again later.',
});

interface Transcript {
  _id: string;
  projectID: string;
  sessionID: string;
}

interface Dialog {
  turnID: string;
  type: string;
  payload: {
    message?: string;
    time: number;
    type: string;
    src?: string;
    image?: string;
    payload: any;
  };
  startTime: string;
  format: string;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTranscripts(vfApiKey: string,
  projectId: string,
  tag?: string,
  range?: string,
  startDate?: string,
  endDate?: string): Promise<Transcript[]> {
    if (!vfApiKey || !projectId) {
      throw new Error('VF API key and project ID are mandatory.');
    }

    const queryParams = new URLSearchParams();
    if (tag) queryParams.append('tag', tag);
    if (range) queryParams.append('range', range);
    if (startDate) queryParams.append('startDate', startDate);
    if (endDate) queryParams.append('endDate', endDate);

    const url = `${API_BASE_URL}/transcripts/${projectId}?${queryParams.toString()}`;
    console.log(url);
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': vfApiKey!,
          'Content-type': 'application/json',
        } as HeadersInit,
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (errorData.message === "Unauthorized") {
          throw new Error("Unauthorized access. Please check your API key.");
        }
        throw new Error(`API request failed: ${response.statusText}`);
      }

      return response.json();
    } catch (error: any) {
      console.error('Error fetching transcripts:', error.message || 'Unknown error');
      console.error('Stack trace:', error.stack);
      throw new Error(`Failed to fetch transcripts: ${error.message || 'Unknown error'}`);
    }
}

async function fetchDialogs(projectID: string, dialogID: string, vfApiKey: string): Promise<Dialog[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/transcripts/${projectID}/${dialogID}`, {
      headers: {
        'Authorization': vfApiKey!,
        'Content-type': 'application/json',
      } as HeadersInit,
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        console.error(`Error: Failed to parse JSON for dialog ID ${dialogID}. Response might not be JSON.`);
        return [];
      }

      if (errorData.message === "Unauthorized") {
        console.error(`Error: Unauthorized access for dialog ID ${dialogID}. Please check your API key.`);
        return [];
      }
      throw new Error(`API request failed for dialog ID ${dialogID}: ${response.statusText}`);
    }
    return response.json();
  } catch (error: any) {
    console.error('Error fetching dialogs:', error.message || 'Unknown error');
    console.error('Stack trace:', error.stack);
    throw new Error(`Failed to fetch dialogs: ${error.message || 'Unknown error'}`);
  }
}

async function redactText(text: string): Promise<string> {
  try {
    const response = await fetch(REDACT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error(`Redaction API error: ${response.statusText}`);
      return text; // Return original text if redaction fails
    }

    const data = await response.json();
    return data.redacted_text || text;
  } catch (error) {
    console.error('Error during redaction:', error);
    return text; // Return original text if redaction fails
  }
}

async function getContentAndOutput(dialog: Dialog, useRedact: boolean): Promise<{ content: string, output: string, ai: boolean }> {
  let content = '';
  let output = '';
  let ai = false;

  const shouldRedact = useRedact && REDACT_API_URL;
  const processText = async (text: string) => {
    if (shouldRedact) {
      return await redactText(text);
    }
    return text;
  };
  ai = dialog.payload?.payload?.ai ? true : false;
  content = dialog.payload ? `"${JSON.stringify(dialog.payload).replace(/"/g, '""').replace(/\n/g, ' ')}"` : '';
  switch (dialog.type) {
    case 'launch':
      content = dialog.format ? `${String(dialog.format).replace(/"/g, '""').replace(/\n/g, ' ')}` : '';
      break;
    case 'choice':
    case 'request':
      if (dialog.payload?.type === 'intent') {
        output = dialog.payload.payload?.query ? `"${await processText(String(dialog.payload.payload?.query).replace(/"/g, '""'))}"` : '';
      }
      break
    case 'knowledgeBase':
      output = dialog.payload.payload?.query?.message ? `"${await processText(String(dialog.payload.payload.query.message).replace(/"/g, '""'))}"` : '';
      break
    case 'cardV2':
    case 'block':
    case 'path':
    case 'flow':
    case 'text':
      output = dialog.payload.payload?.message ? `"${await processText(String(dialog.payload.payload.message).replace(/"/g, '""'))}"` : '';
      break
    case 'speak':
      if (dialog.payload?.type === 'audio') {
        output = dialog.payload?.src ? `"${String(dialog.payload.src).replace(/"/g, '""')}"` : '';
      }
      if (dialog.payload?.type === 'message') {
        output = dialog.payload?.message ? `"${await processText(String(dialog.payload.message).replace(/"/g, '""'))}"` : '';
      }
      break
    case 'visual':
      output = dialog.payload?.image ? `"${String(dialog.payload.image).replace(/"/g, '""')}"` : '';
      break
    case 'carousel':
    case 'debug':
    case 'no-reply':
      content = dialog.payload?.payload ? `"${JSON.stringify(dialog.payload.payload).replace(/"/g, '""').replace(/\n/g, ' ')}"` : '';
      break;
    case 'end':
      content = 'end';
      output = 'end';
      break;
    default:
      content = dialog.payload ? `"${JSON.stringify(dialog.payload).replace(/"/g, '""').replace(/\n/g, ' ')}"` : '';
  }

  return { content, output, ai };
}

async function jsonToCsv(jsonData: Dialog[], sessionID: string, transcriptID: string, useRedact: boolean): Promise<string> {
  const headers = [
    'transcriptID',
    'sessionID',
    'startTime',
    'turnID',
    'type',
    'event',
    'content',
    'output',
    'ai',
    'intent_matched',
    'confidence_interval',
    'model',
    'token_multiplier',
    'token_consumption_total',
    'token_consumption_query',
    'token_consumption_answer'
  ];
  const csvRows = [headers.join(',')];

  for (const dialog of jsonData) {
    const { content, output, ai } = await getContentAndOutput(dialog, useRedact);
    const turnID = dialog.turnID;
    const type = dialog.type;
    let event = dialog.payload.type;
    const startTime = dialog.startTime;
    let model = '';
    let token_multiplier = 0;
    let token_consumption_total = 0;
    let token_consumption_query = 0;
    let token_consumption_answer = 0;

    if (type === 'debug' && dialog.payload.payload?.message.startsWith('__AI ')) {
      const message = dialog.payload.payload?.message || '';
      const modelMatch = message.match(/Model: `([^`]+)`/);
      const tokenMultiplierMatch = message.match(/Token Multiplier: `(\d+(\.\d+)?)x`/);
      const tokenConsumptionMatch = message.match(/Token Consumption: `{total: (\d+), query: (\d+), answer: (\d+)}`/);

      model = modelMatch ? modelMatch[1] : '';
      token_multiplier = tokenMultiplierMatch ? parseFloat(tokenMultiplierMatch[1]) : 0;
      if (tokenConsumptionMatch) {
        token_consumption_total = tokenConsumptionMatch[1];
        token_consumption_query = tokenConsumptionMatch[2];
        token_consumption_answer = tokenConsumptionMatch[3];
      }
    }

    const intent_matched = dialog.payload.payload?.intent?.name ? `"${String(dialog.payload.payload.intent.name).replace(/"/g, '""')}"` : '';
    const confidence_interval = dialog.payload.payload?.confidence ? `"${String(dialog.payload.payload.confidence)}"` : '';

    const row = [
      transcriptID,
      sessionID,
      startTime,
      turnID,
      type,
      event,
      content,
      output,
      ai,
      intent_matched,
      confidence_interval,
      model,
      token_multiplier,
      token_consumption_total,
      token_consumption_query,
      token_consumption_answer
    ];
    csvRows.push(row.join(','));
  };

  return csvRows.join('\n');
}

async function saveCsvFile(filePath: string, csvContent: string) {
  await writeFile(filePath, csvContent);
}

const app = express();

app.get('/export', timeout(TIMEOUT), limiter, async (req: Request, res: Response): Promise<void> => {
  const { vfApiKey, projectId, tag, range = 'Today', startDate, endDate, redact, singleFile } = req.query as {
    vfApiKey: string;
    projectId: string;
    tag?: string;
    range?: string;
    startDate?: string;
    endDate?: string;
    redact?: string;
    singleFile?: string;
  };

  const shouldUseRedact = redact ?
  redact.toLowerCase() === 'true' :
  USE_REDACT === 'true';

  const apiKey = vfApiKey || VF_API_KEY;
  const projectID = projectId || PROJECT_ID;
  const authToken = (req.headers['authorization'] as string | undefined) || '';
  const sanitizedProjectId = basename(projectId || PROJECT_ID || '');
  const validRanges = ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'All time'];

  if (!apiKey || !projectID) {
    res.status(400).send('VF API key and project ID are required.');
    return;
  }

  if (shouldUseRedact && !REDACT_API_URL) {
    res.status(400).send('Redaction requested but REDACT_API_URL is not configured.');
    return;
  }

  if (range && !validRanges.includes(range)) {
    res.status(400).send(`Invalid range value. Must be one of: ${validRanges.join(', ')}`);
    return
  }


  if (startDate && !isISO8601(startDate)) {
    res.status(400).send('Invalid start date format.');
    return;
  }

  if (endDate && !isISO8601(endDate)) {
    res.status(400).send('Invalid end date format.');
    return;
  }

  if (!authToken || !timingSafeEqual(Buffer.from(authToken ?? ''), Buffer.from(AUTHORIZATION_TOKEN ?? ''))) {
    res.status(401).send('Unauthorized: Invalid authorization token.');
    return;
  }

  try {
    console.log('Fetching transcripts...');
    const transcripts = await fetchTranscripts(apiKey, projectID, tag, range, startDate, endDate);
    const timestamp = Date.now();
    const outputDir = join('/tmp', 'exports', `${sanitizedProjectId}_${timestamp}`);
    await mkdir(outputDir, { recursive: true });

    if (singleFile === 'true') {
      // Create a single CSV file with all transcripts
      let isFirstFile = true;
      let consolidatedCsvContent = '';

      for (const transcript of transcripts) {
        const dialogID = transcript._id;
        const sessionID = transcript.sessionID;
        if (EXTRA_LOGS === 'true') {
          console.log(`Processing${shouldUseRedact ? ' and redacting' : ''} dialog ID: ${dialogID}`);
        }
        await delay(DELAY);
        const jsonData = await fetchDialogs(sanitizedProjectId, dialogID, apiKey);
        if (jsonData.length > 0) {
          const csvContent = await jsonToCsv(jsonData, sessionID, dialogID, shouldUseRedact);
          if (isFirstFile) {
            consolidatedCsvContent = csvContent;
            isFirstFile = false;
          } else {
            // Skip the header row for subsequent files
            consolidatedCsvContent += '\n' + csvContent.split('\n').slice(1).join('\n');
          }
        }
      }

      const consolidatedFilePath = join(outputDir, `${sanitizedProjectId}_all_transcripts.csv`);
      await saveCsvFile(consolidatedFilePath, consolidatedCsvContent);
      if (EXTRA_LOGS) console.log('Consolidated CSV file created');
    } else {
      // Existing code for individual files
      for (const transcript of transcripts) {
        const dialogID = transcript._id;
        const sessionID = transcript.sessionID;
        if (EXTRA_LOGS === 'true') {
          console.log(`Processing${shouldUseRedact ? ' and redacting' : ''} dialog ID: ${dialogID}`);
        }
        await delay(DELAY);
        const jsonData = await fetchDialogs(sanitizedProjectId, dialogID, apiKey);
        if (jsonData.length > 0) {
          const csvContent = await jsonToCsv(jsonData, sessionID, dialogID, shouldUseRedact);
          const filePath = join(outputDir, `${dialogID}.csv`);
          await saveCsvFile(filePath, csvContent);
          if (EXTRA_LOGS) console.log(`CSV file created for dialog ID: ${dialogID}`);
        }
      }
    }

    const zipFilePath = join('/tmp', 'exports', `${sanitizedProjectId}_${timestamp}.zip`);
    const output = createWriteStream(zipFilePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(output);
    archive.directory(outputDir, false);
    archive.finalize();

    output.on('close', async() => {
      console.log(`Zip file generated: ${sanitizedProjectId}_${timestamp}.zip`);
      res.download(zipFilePath, `${sanitizedProjectId}_${timestamp}.zip`, async (err) => {
        if (err) {
          console.error('Error sending file:', err);
          res.status(500).send('Error sending file.');
        } else {
          try {
            // Remove the directory and the zip file after sending
            await rm(outputDir, { recursive: true, force: true });
            await rm(zipFilePath, { force: true });
            console.log('Temporary files and directories removed successfully.');
          } catch (removeError) {
            console.error('Error removing temporary files:', removeError);
          }
        }
      });
    });

  } catch (error) {
    console.error('An error occurred:', error);
    res.status(500).send('An error occurred while processing your request.');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
