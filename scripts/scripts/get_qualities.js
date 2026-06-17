/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs/promises');
const path = require('path');

/**
 * Formats bandwidth into a human-readable string containing both kbps and Mbps.
 * @param {string|number} bandwidthBps Bandwidth in bits per second
 * @returns {string} Formatted bandwidth string
 */
function formatBandwidth(bandwidthBps) {
  if (!bandwidthBps) return '';
  const bps = parseInt(bandwidthBps, 10);
  const mbps = (bps / 1000000).toFixed(2);
  
  // Format clean Mbps (remove trailing zeroes or decimal point if appropriate)
  let mbpsStr = mbps;
  if (mbps.endsWith('.00')) {
    mbpsStr = mbps.slice(0, -3);
  } else if (mbps.endsWith('0')) {
    mbpsStr = mbps.slice(0, -1);
  }
  
  return ` (${mbpsStr} Mbps)`;
}

async function getStreamQualities() {
  const filePathArg = process.argv[2];
  if (!filePathArg) {
    console.error('Usage: node test/get_qualities.js <path-to-json-or-m3u-file>');
    process.exit(1);
  }

  const filePath = path.resolve(filePathArg);
  
  let data = [];
  try {
    const ext = path.extname(filePath).toLowerCase();
    const fileContent = await fs.readFile(filePath, 'utf8');

    if (ext === '.json') {
      data = JSON.parse(fileContent);
    } else if (ext === '.m3u' || ext === '.m3u8') {
      const lines = fileContent.split(/\r?\n/);
      let currentName = '';
      for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
          const commaIndex = line.lastIndexOf(',');
          currentName = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : 'Unknown';
        } else if (line.trim() && !line.startsWith('#')) {
          data.push({ name: currentName || 'Unknown', url: line.trim() });
          currentName = '';
        }
      }
    } else {
      console.error('Unsupported file format. Please provide a .json or .m3u file.');
      process.exit(1);
    }
  } catch (e) {
    console.error(`Failed to read or parse file at ${filePath}:`, e);
    return;
  }

  console.log(`Found ${data.length} total streams. Checking available qualities...\n`);

  for (const stream of data) {
    const isDash = stream.type === 'dash' || (stream.url && stream.url.includes('.mpd'));
    const isHls = !isDash && (stream.url && stream.url.includes('.m3u8'));
    const isTs = !isDash && !isHls && (stream.url && stream.url.includes('.ts'));

    if (!isDash && !isHls && !isTs) {
      console.log(`Checking: ${stream.name}`);
      console.log(`  [-] Unknown stream format (not DASH, HLS, or TS): ${stream.url || 'No URL'}\n`);
      continue;
    }

    const streamTypeStr = isDash ? 'DASH' : isHls ? 'HLS' : 'TS';
    console.log(`Fetching ${streamTypeStr} for: ${stream.name}`);

    if (isTs) {
      console.log(`  [-] Direct TS Stream (Single quality / No sub-qualities found)\n`);
      continue;
    }

    try {
      const response = await fetch(stream.url);
      if (!response.ok) {
        console.error(`  [!] Failed to fetch stream: ${response.status} ${response.statusText}`);
        console.log('');
        continue;
      }
      const text = await response.text();

      const streamQualities = [];

      function addQuality(height, bandwidth) {
        const bwInfo = bandwidth ? formatBandwidth(bandwidth) : '';
        const heightStr = height > 0 ? `${height}p` : 'Unknown Res';
        const label = `${heightStr}${bwInfo}`;
        
        if (!streamQualities.some(q => q.height === height && q.bandwidth === bandwidth)) {
          streamQualities.push({ height, bandwidth, label });
        }
      }

      if (isDash) {
        // Regex to extract height and bandwidth from Representation tags
        const representationRegex = /<Representation[^>]+>/g;
        const heightRegex = /height="(\d+)"/;
        const bandwidthRegex = /bandwidth="(\d+)"/;

        let match;
        while ((match = representationRegex.exec(text)) !== null) {
          const repStr = match[0];
          const heightMatch = repStr.match(heightRegex);
          if (heightMatch) {
            const height = parseInt(heightMatch[1], 10);
            const bwMatch = repStr.match(bandwidthRegex);
            const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            addQuality(height, bandwidth);
          }
        }

        if (streamQualities.length > 0) {
          streamQualities.sort((a, b) => {
            if (b.height !== a.height) return b.height - a.height;
            return b.bandwidth - a.bandwidth;
          });
          const sortedQualities = streamQualities.map(q => q.label);
          console.log(`  [+] Available Qualities: ${sortedQualities.join(', ')}`);
        } else {
          console.log(`  [-] No standard video qualities (height) found in MPD.`);
        }
      } else {
        // HLS
        const streamInfRegex = /#EXT-X-STREAM-INF:([^]+?)(?=\n[^#]|$)/g;
        let match;
        let hasStreamInf = false;

        while ((match = streamInfRegex.exec(text)) !== null) {
          hasStreamInf = true;
          const attributesStr = match[1];
          const resMatch = attributesStr.match(/RESOLUTION=(\d+x\d+)/);
          const bwMatch = attributesStr.match(/BANDWIDTH=(\d+)/);

          if (resMatch) {
            const height = parseInt(resMatch[1].split('x')[1], 10);
            const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            addQuality(height, bandwidth);
          } else if (bwMatch) {
            const bandwidth = parseInt(bwMatch[1], 10);
            addQuality(0, bandwidth);
          }
        }

        if (streamQualities.length > 0) {
          streamQualities.sort((a, b) => {
            if (b.height !== a.height) return b.height - a.height;
            return b.bandwidth - a.bandwidth;
          });
          const sortedQualities = streamQualities.map(q => q.label);
          console.log(`  [+] Available Qualities: ${sortedQualities.join(', ')}`);
        } else if (!hasStreamInf) {
          console.log(`  [-] Single quality stream / Media Playlist (No sub-qualities found)`);
        } else {
          console.log(`  [-] Master playlist found, but no standard resolutions specified.`);
        }
      }
    } catch (e) {
      console.error(`  [!] Error fetching or parsing stream: ${e.message}`);
    }
    console.log(''); // Blank line for readability
  }
}

getStreamQualities();
