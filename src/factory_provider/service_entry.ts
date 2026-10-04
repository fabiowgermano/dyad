import { runFactoryDyadService } from "./service_main";

void runFactoryDyadService().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    JSON.stringify({
      event: "factory-dyad-provider.start-failed",
      message: message.slice(0, 2_000),
    }) + "\n",
  );
  process.exit(1);
});
