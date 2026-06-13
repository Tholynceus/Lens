const SUPABASE_URL = process.env.LENS_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.LENS_SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const results = await indexBankrLaunches();
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function indexBankrLaunches() {
  const res = await fetch('https://api.bankr.bot/token-launches?limit=100');
  if (!res.ok) throw new Error('Bankr API failed');
  const data = await res.json();
  const launches = Array.isArray(data) ? data : (data.launches || data.data || []);
  if (!launches.length) return { indexed: 0 };

  let indexed = 0;
  for (const launch of launches) {
    const tokenAddress = launch.tokenAddress || launch.address;
    if (!tokenAddress) continue;
    const xUsername = launch.deployer?.xUsername || launch.deployer?.twitterHandle || launch.xUsername || null;
    const deployerWallet = launch.deployer?.walletAddress || launch.deployerAddress;
    const feeRecipientWallet = launch.feeRecipient?.walletAddress || launch.feeRecipientAddress;

    const row = {
      token_address: tokenAddress.toLowerCase(),
      token_name: launch.tokenName || launch.name,
      token_symbol: launch.tokenSymbol || launch.symbol,
      chain: launch.chain || 'base',
      status: launch.status || 'deployed',
      deployer_wallet: deployerWallet?.toLowerCase(),
      fee_recipient_wallet: feeRecipientWallet?.toLowerCase(),
      x_username: xUsername?.toLowerCase(),
      x_user_id: launch.deployer?.xUserId || null,
      image_url: launch.imageUri || launch.imageUrl,
      launched_at: launch.timestamp || launch.createdAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await fetch(`${SUPABASE_URL}/rest/v1/bankr_launches`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    indexed++;
  }
  return { indexed, total: launches.length };
}
