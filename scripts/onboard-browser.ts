import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CRUNCHYROLL_LOGIN_URL } from "../src/transport/browser-auth.js";
import { browserLaunchEnvironment } from "./browser-subprocess-environment.js";
import {
  browserProfileDir,
  ensureBrowserProfile,
  resolveBrowserExecutable,
} from "../src/transport/browser-profile.js";

export class OnboardingBlocked extends Error {
  constructor(readonly reason: "display_unavailable" | "profile_in_use" | "browser_exit") {
    super(reason);
  }
}

// The optional parameters are filesystem/environment seams for local tests.
// The CLI always uses the fixed dedicated profile and fixed login URL.
export async function prepareManualBrowser(
  profile = browserProfileDir(),
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<{ executable: string; args: string[] }> {
  if (platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
    throw new OnboardingBlocked("display_unavailable");
  }
  const executable = resolveBrowserExecutable(environment);
  await ensureBrowserProfile(profile);
  try {
    // lstat also detects a dangling SingletonLock. Never delete or repair it;
    // refusing avoids forwarding this navigation into a managed browser.
    await lstat(join(profile, "SingletonLock"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { executable, args: [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-mode",
      CRUNCHYROLL_LOGIN_URL,
    ] };
  }
  throw new OnboardingBlocked("profile_in_use");
}

export async function openManualBrowser(): Promise<void> {
  const plan = await prepareManualBrowser();
  console.error(`Navegador selecionado: ${plan.executable}`);
  console.error("Abrindo o perfil dedicado para login manual, sem conexão CDP.");
  console.error("Faça a verificação e o login diretamente no Crunchyroll. Não importe dados de outro navegador.");
  console.error("Depois de confirmar o login na página, feche esta janela normalmente para liberar o perfil.");
  const child = spawn(plan.executable, plan.args, {
    stdio: "ignore", shell: false, env: browserLaunchEnvironment(),
  });
  const interrupt = (): void => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const code = await new Promise<number | null>((fulfill, reject) => {
      child.once("error", reject);
      child.once("exit", fulfill);
    });
    if (code !== 0) throw new OnboardingBlocked("browser_exit");
    console.error("Janela encerrada. A autenticação ainda precisa ser validada pelo MCP.");
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function main(): Promise<void> {
  // No additional argument may select a URL, profile, flag or credential.
  if (process.argv.length > 2) {
    console.error("Este comando não aceita argumentos. Faça login somente na janela do navegador.");
    process.exitCode = 2;
    return;
  }
  try {
    await openManualBrowser();
    console.error("Próximo passo: npm run validate:live -- --login");
  } catch (error) {
    if (error instanceof OnboardingBlocked && error.reason === "profile_in_use") {
      console.error("O perfil dedicado está ocupado ou tem um SingletonLock pendente.");
      console.error("Feche as janelas desse perfil e encerre a validação MCP antes de tentar novamente. Não apague o lock.");
    } else if (error instanceof OnboardingBlocked && error.reason === "display_unavailable") {
      console.error("Abra um terminal na sua sessão gráfica e execute sem sudo.");
    } else if (error instanceof OnboardingBlocked) {
      console.error("O navegador não encerrou normalmente. Nenhum login foi validado pelo script.");
    } else {
      console.error("Não foi possível abrir o navegador. Verifique o executável e as permissões do perfil dedicado (0700).");
    }
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
