const { exec } = require("child_process");
const https = require("https");

const REQUEST_TIMEOUT_MS = 5000;

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function extractArgValue(commandLine, flagName) {
  const regex = new RegExp(`${flagName}[=\\s]+(?:["']([^"']+)["']|([^\\s"']+))`);
  const match = commandLine.match(regex);
  if (!match) {
    return null;
  }
  return match[1] || match[2] || null;
}

async function findAntigravityProcess() {
  const processQuery = [
    "powershell -NoProfile -Command",
    '"Get-CimInstance Win32_Process',
    "| Where-Object { ($_.Name -like '*antigravity*') -or ($_.CommandLine -like '*antigravity*') }",
    '| Select-Object ProcessId, CommandLine',
    '| ConvertTo-Json -Depth 1"'
  ].join(" ");

  let output;
  try {
    output = await runCommand(processQuery);
  } catch {
    return null;
  }

  if (!output.trim()) {
    return null;
  }

  let processes;
  try {
    processes = JSON.parse(output);
  } catch {
    return null;
  }

  const list = Array.isArray(processes) ? processes : [processes];

  for (const processInfo of list) {
    const commandLine = processInfo.CommandLine || "";
    if (!commandLine.includes("--csrf_token")) {
      continue;
    }

    const csrfToken = extractArgValue(commandLine, "--csrf_token");
    if (csrfToken) {
      return {
        pid: String(processInfo.ProcessId),
        csrfToken
      };
    }
  }

  return null;
}

async function findListeningPorts(pid) {
  let output;
  try {
    output = await runCommand("netstat -ano");
  } catch {
    return [];
  }

  const ports = new Set();
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const columns = line.split(/\s+/);
    if (columns.length < 5) {
      continue;
    }

    const localAddress = columns[1];
    const state = columns[3];
    const processId = columns[4];

    if (processId !== pid || state !== "LISTENING") {
      continue;
    }

    if (!localAddress.startsWith("127.0.0.1")) {
      continue;
    }

    const portText = localAddress.split(":").pop();
    const port = Number(portText);
    if (Number.isInteger(port) && port > 0) {
      ports.add(port);
    }
  }

  return [...ports];
}

function fetchUserStatus(port, csrfToken) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid JSON response"));
          }
        });
      }
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Request timed out"));
    });

    request.write(
      JSON.stringify({
        metadata: {
          ideName: "antigravity",
          extensionName: "antigravity",
          ideVersion: "1.0.0"
        }
      })
    );
    request.end();
  });
}

function formatDate(dateValue) {
  if (!dateValue) {
    return "N/A";
  }
  return new Date(dateValue).toLocaleString();
}

function printUsage(status) {
  const user = status?.userStatus;
  if (!user) {
    console.log("No user status returned.");
    return;
  }

  console.log("Antigravity quota usage");
  console.log("----------------------------------------");
  console.log(`User: ${user.email || "Unknown"}`);

  const monthlyCredits = user.planStatus?.planInfo?.monthlyPromptCredits;
  const availableCredits = user.planStatus?.availablePromptCredits;

  if (Number.isFinite(monthlyCredits) && Number.isFinite(availableCredits)) {
    const usedCredits = monthlyCredits - availableCredits;
    const percentage = monthlyCredits > 0 ? Math.round((usedCredits / monthlyCredits) * 100) : 0;
    console.log(`Credits: ${usedCredits} / ${monthlyCredits} used (${percentage}%)`);
  }

  const configs = user.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) {
    return;
  }

  const models = configs.filter((model) => {
    const label = model.label || model.modelOrAlias?.model || "";
    const normalized = label.toLowerCase();
    return !normalized.includes("autocomplete") && !normalized.includes("embedding");
  });

  if (models.length === 0) {
    return;
  }

  console.log("\nModel quotas:");
  for (const model of models) {
    const label = model.label || model.modelOrAlias?.model || "Unknown";
    const remainingFraction = model.quotaInfo?.remainingFraction;
    const remaining = Number.isFinite(remainingFraction)
      ? `${Math.round(remainingFraction * 100)}%`
      : "N/A";
    const resetTime = formatDate(model.quotaInfo?.resetTime);

    console.log(`- ${label}: remaining ${remaining}, resets ${resetTime}`);
  }
}

async function main() {
  const processInfo = await findAntigravityProcess();
  if (!processInfo) {
    throw new Error("Could not find an Antigravity process with csrf token.");
  }

  const ports = await findListeningPorts(processInfo.pid);
  if (ports.length === 0) {
    throw new Error("No local listening ports found for Antigravity process.");
  }

  let status = null;
  for (const port of ports) {
    try {
      status = await fetchUserStatus(port, processInfo.csrfToken);
      break;
    } catch {
      status = null;
    }
  }

  if (!status) {
    throw new Error("Could not connect to Antigravity local server.");
  }

  printUsage(status);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
