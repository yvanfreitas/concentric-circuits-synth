const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Color helpers for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
};

function logInfo(msg) {
  console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`);
}

function logSuccess(msg) {
  console.log(`${colors.green}[SUCCESS]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
}

function logWarning(msg) {
  console.log(`${colors.yellow}[WARNING]${colors.reset} ${msg}`);
}

function logError(msg) {
  console.error(`${colors.red}[ERROR]${colors.reset} ${colors.bright}${msg}${colors.reset}`);
}

function getToken() {
  try {
    const token = execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return token.trim();
  } catch (err) {
    return null;
  }
}

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) {
            reject({ statusCode: res.statusCode, error: parsed });
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject({ statusCode: res.statusCode, message: body });
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

function promptQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function run() {
  console.log(`\n${colors.bright}=== Google Analytics Setup Utility ===${colors.reset}\n`);
  
  let token = getToken();
  if (!token) {
    logError("Não foi possível obter o token de acesso do gcloud. Você está autenticado?");
    console.log(`Por favor, certifique-se de que o gcloud CLI está instalado e configurado.`);
    return;
  }

  logInfo("Autenticado no Google Cloud. Buscando contas do Google Analytics...");

  let accountsData;
  try {
    accountsData = await makeRequest({
      hostname: 'analyticsadmin.googleapis.com',
      path: '/v1beta/accounts',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    if (err.statusCode === 403 && err.error?.error?.status === 'PERMISSION_DENIED') {
      logError("Escopo de autenticação gcloud insuficiente!");
      console.log(`\nPara acessar e configurar o Google Analytics, você precisa autenticar o gcloud CLI com o escopo de analytics.`);
      console.log(`${colors.bright}Por favor, execute o seguinte comando no seu terminal:${colors.reset}\n`);
      console.log(`  ${colors.green}gcloud auth login --update-no-cache --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics"${colors.reset}\n`);
      console.log("Depois de fazer login no navegador, execute este script novamente.");
      return;
    }
    logError("Erro ao fazer requisição à API Admin do Google Analytics: " + (err.error?.error?.message || err.message || JSON.stringify(err)));
    return;
  }

  const accounts = accountsData.accounts || [];
  if (accounts.length === 0) {
    logError("Nenhuma conta do Google Analytics encontrada!");
    console.log("Crie uma conta do Google Analytics primeiro acessando https://analytics.google.com");
    return;
  }

  let selectedAccount = null;
  if (accounts.length === 1) {
    selectedAccount = accounts[0];
    logInfo(`Usando a única conta encontrada: ${colors.bright}${selectedAccount.displayName}${colors.reset} (${selectedAccount.name})`);
  } else {
    console.log("\nContas do Google Analytics disponíveis:");
    accounts.forEach((acc, idx) => {
      console.log(`  [${idx + 1}] ${acc.displayName} (${acc.name})`);
    });
    
    let index = -1;
    while (index < 0 || index >= accounts.length) {
      const choice = await promptQuestion(`\nSelecione o número da conta desejada (1-${accounts.length}): `);
      const parsed = parseInt(choice);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= accounts.length) {
        index = parsed - 1;
      } else {
        logWarning("Seleção inválida.");
      }
    }
    selectedAccount = accounts[index];
  }

  logInfo(`Criando propriedade GA4 "Synth Prophet-5 Concentric"...`);

  let property;
  try {
    property = await makeRequest({
      hostname: 'analyticsadmin.googleapis.com',
      path: '/v1beta/properties',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, {
      parent: selectedAccount.name,
      displayName: "Synth Prophet-5 Concentric",
      timeZone: "America/New_York",
      currencyCode: "USD"
    });
    logSuccess(`Propriedade GA4 criada: ${property.displayName} (${property.name})`);
  } catch (err) {
    logError("Erro ao criar propriedade GA4: " + (err.error?.error?.message || JSON.stringify(err)));
    return;
  }

  logInfo(`Criando Web Data Stream para a propriedade...`);

  let webStream;
  try {
    webStream = await makeRequest({
      hostname: 'analyticsadmin.googleapis.com',
      path: `/v1beta/${property.name}/webDataStreams`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, {
      defaultUri: "https://synth-prophet5.run.app",
      displayName: "Web Stream"
    });
    logSuccess(`Fluxo de dados da web criado: ${webStream.displayName}`);
    logSuccess(`Measurement ID obtido: ${colors.bright}${webStream.measurementId}${colors.reset}`);
  } catch (err) {
    logError("Erro ao criar fluxo de dados da web: " + (err.error?.error?.message || JSON.stringify(err)));
    return;
  }

  const measurementId = webStream.measurementId;
  if (!measurementId) {
    logError("ID de Rastreamento (Measurement ID) não encontrado na resposta!");
    return;
  }

  logInfo("Atualizando arquivo index.html com o novo ID...");

  const htmlPath = path.join(__dirname, 'index.html');
  try {
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
    
    // Replace meta tag content
    const metaRegex = /(<meta name="ga-measurement-id" content=")[^"]*(")/;
    if (metaRegex.test(htmlContent)) {
      htmlContent = htmlContent.replace(metaRegex, `$1${measurementId}$2`);
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      logSuccess(`Sucesso! index.html atualizado com o ID: ${measurementId}`);
      console.log(`\nAgora, quando você rodar o sintetizador ou subir no Cloud Run, os eventos serão computados na sua propriedade.`);
    } else {
      logError("Meta tag 'ga-measurement-id' não encontrada no arquivo HTML!");
    }
  } catch (err) {
    logError("Falha ao abrir ou atualizar o arquivo HTML: " + err.message);
  }
  
  console.log(`\n=== Configuração concluída! ===\n`);
}

run().catch((err) => {
  logError("Ocorreu um erro inesperado: " + err.stack);
});
