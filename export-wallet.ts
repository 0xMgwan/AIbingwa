import { CdpSmartWalletProvider } from "@coinbase/agentkit";
import "dotenv/config";

async function main() {
  console.log("🔧 Initializing wallet to export data...");
  
  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    walletSecret: process.env.CDP_WALLET_SECRET!,
    networkId: (process.env.NETWORK_ID || "base-mainnet") as any,
  });

  const exported = await walletProvider.exportWallet();
  
  console.log("\n✅ Wallet exported successfully!");
  console.log("   Owner Address:", exported.ownerAddress);
  console.log("   Smart Wallet Address:", exported.address);
  console.log("   Name:", exported.name);
  
  console.log("\n📋 Add these to your .env and Railway env vars:");
  console.log(`OWNER_ADDRESS=${exported.ownerAddress}`);
  console.log(`SMART_WALLET_ADDRESS=${exported.address}`);
  
  // Save to file
  const fs = await import("fs");
  fs.writeFileSync("wallet-data.json", JSON.stringify({
    ownerAddress: exported.ownerAddress,
    smartWalletAddress: exported.address,
  }, null, 2));
  console.log("\n💾 Saved to wallet-data.json");
}

main().catch(console.error);
