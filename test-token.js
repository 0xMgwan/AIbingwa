import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("❌ TELEGRAM_BOT_TOKEN not found in .env");
  process.exit(1);
}

console.log("Token found:", token.substring(0, 20) + "...");

// Test the token
const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const data = await response.json();

if (data.ok) {
  console.log("✅ Bot token is valid!");
  console.log("Bot username:", data.result.username);
  console.log("Bot name:", data.result.first_name);
} else {
  console.error("❌ Bot token is invalid!");
  console.error("Error:", data.description);
}
