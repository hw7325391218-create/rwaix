import { fileURLToPath } from "node:url";
import { startVcApi } from "./http.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = await startVcApi({ port: Number(process.env.VC_API_PORT ?? 9891) });
  console.log(`RWAIX VC-API http://${started.host}:${started.port}`);
  console.log(`eddsa-rdfc-2022 ${started.eddsaDid}`);
  console.log(`ecdsa-rdfc-2019 ${started.ecdsaDid}`);
}
