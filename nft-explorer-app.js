// BUILD: Jan02-v2 - DAO Member name search, member names displayed with addresses, NFT modal member display
// --- Global Elements ---
const gallery = document.getElementById('nft-gallery');
const paginationControls = document.getElementById('pagination-controls');
const searchInput = document.getElementById('search-id');
const searchAddressInput = document.getElementById('search-address');
const addressDropdown = document.getElementById('address-dropdown');
const sortSelect = document.getElementById('sort-rank');
const traitFiltersContainer = document.getElementById('trait-filters-container');
const inhabitantFiltersContainer = document.getElementById('inhabitant-filters-container');
const planetFiltersContainer = document.getElementById('planet-filters-container');
const statusFiltersGrid = document.getElementById('status-filters-grid');
const mintStatusContainer = document.getElementById('mint-status-container');
const traitTogglesContainer = document.getElementById('trait-toggles-container');
const resetButton = document.getElementById('reset-filters');
const resultsCount = document.getElementById('results-count');
const nftModal = document.getElementById('nft-modal');
const modalCloseBtn = document.getElementById('modal-close');
const rarityModal = document.getElementById('rarity-modal');
const rarityExplainedBtn = document.getElementById('rarity-explained-btn');
const rarityModalCloseBtn = document.getElementById('rarity-modal-close');
const sortingModal = document.getElementById('sorting-modal');
const sortingExplainedBtn = document.getElementById('sorting-explained-btn');
const sortingModalCloseBtn = document.getElementById('sorting-modal-close');
const badgeModal = document.getElementById('badge-modal');
const badgesExplainedBtn = document.getElementById('badges-explained-btn');
const badgeModalCloseBtn = document.getElementById('badge-modal-close');
const matchingTraitsToggle = document.getElementById('matching-traits-toggle');
const matchingTraitsSlider = document.getElementById('matching-traits-slider');
const matchingTraitsCount = document.getElementById('matching-traits-count');
const collectionViewBtn = document.getElementById('collection-view-btn');
const walletViewBtn = document.getElementById('wallet-view-btn');
const analyticsViewBtn = document.getElementById('analytics-view-btn');
const mapViewBtn = document.getElementById('map-view-btn');
const collectionView = document.getElementById('collection-view');
const walletView = document.getElementById('wallet-view');
const analyticsView = document.getElementById('analytics-view');
const mapView = document.getElementById('map-view');
const walletSearchAddressInput = document.getElementById('wallet-search-address');
const walletCopyAddressBtn = document.getElementById('wallet-copy-address-btn');
const walletAddressSuggestions = document.getElementById('wallet-address-suggestions');
const walletResetBtn = document.getElementById('wallet-reset-btn');
const leaderboardTable = document.getElementById('leaderboard-table');
const leaderboardPagination = document.getElementById('leaderboard-pagination');
const walletTraitTogglesContainer = document.getElementById('wallet-trait-toggles-container');
const walletGallery = document.getElementById('wallet-gallery');
const walletGalleryTitle = document.getElementById('wallet-gallery-title');
const addressSuggestions = document.getElementById('address-suggestions');
const copyAddressBtn = document.getElementById('copy-address-btn');
const copyToast = document.getElementById('copy-toast');
const walletExplorerModal = document.getElementById('wallet-explorer-modal');
const walletModalCloseBtn = document.getElementById('wallet-modal-close');
const systemLeaderboardModal = document.getElementById('system-leaderboard-modal');
const systemModalCloseBtn = document.getElementById('system-modal-close');
const spaceCanvas = document.getElementById('space-canvas');
// Add references for new toggles
const togInhabBtn = document.getElementById('toggle-inhabitant-filters');
const inhabArrow = document.getElementById('inhabitant-arrow');
const togPlanBtn = document.getElementById('toggle-planet-filters');
const planArrow = document.getElementById('planet-arrow');
const togStatusBtn = document.getElementById('toggle-status-filters');
const statusArrow = document.getElementById('status-arrow');
const statusFiltersExtra = document.getElementById('status-filters-extra');
// Address direction toggle buttons (old)
const addressDirectionToggle = document.getElementById('address-direction-toggle');
const walletAddressDirectionToggle = document.getElementById('wallet-address-direction-toggle');
// NEW: Last 4 search elements (Desktop)
const searchLast4Input = document.getElementById('search-last4');
const last4Suggestions = document.getElementById('last4-suggestions');
const last4LtrBtn = document.getElementById('last4-ltr-btn');
const last4RtlBtn = document.getElementById('last4-rtl-btn');
const copyLast4Btn = document.getElementById('copy-last4-btn');
// NEW: Copy verification modal
const copyVerifyModal = document.getElementById('copy-verify-modal');
const copyVerifyAddress = document.getElementById('copy-verify-address');
const copyVerifyBtn = document.getElementById('copy-verify-btn');
// NEW: Mobile search elements
const mobileSearchAddress = document.getElementById('mobile-search-address');
const mobileAddressSuggestions = document.getElementById('mobile-address-suggestions');
const mobileAddressDropdown = document.getElementById('mobile-address-dropdown');
const mobileAsReadBtn = document.getElementById('mobile-as-read-btn');
const mobileLast4LtrBtn = document.getElementById('mobile-last4-ltr-btn');
const mobileLast4RtlBtn = document.getElementById('mobile-last4-rtl-btn');
const mobileCopyBtn = document.getElementById('mobile-copy-btn');
// NEW: Paste buttons
const pasteAddressBtn = document.getElementById('paste-address-btn');
const mobilePasteBtn = document.getElementById('mobile-paste-btn');
// NEW: DAO Member buttons
const daoMemberBtn = document.getElementById('dao-member-btn');
const mobileDaoMemberBtn = document.getElementById('mobile-dao-member-btn');
// NEW: Wallet page search elements
const walletSearchLast4 = document.getElementById('wallet-search-last4');
const walletLast4Suggestions = document.getElementById('wallet-last4-suggestions');
const walletLast4LtrBtn = document.getElementById('wallet-last4-ltr-btn');
const walletLast4RtlBtn = document.getElementById('wallet-last4-rtl-btn');
const walletPasteBtn = document.getElementById('wallet-paste-btn');
const walletCopyLast4Btn = document.getElementById('wallet-copy-last4-btn');
const walletMobileSearchAddress = document.getElementById('wallet-mobile-search-address');
const walletMobileSuggestions = document.getElementById('wallet-mobile-suggestions');
const walletMobileAsReadBtn = document.getElementById('wallet-mobile-as-read-btn');
const walletMobileLast4LtrBtn = document.getElementById('wallet-mobile-last4-ltr-btn');
const walletMobileLast4RtlBtn = document.getElementById('wallet-mobile-last4-rtl-btn');
const walletMobilePasteBtn = document.getElementById('wallet-mobile-paste-btn');
const walletMobileCopyBtn = document.getElementById('wallet-mobile-copy-btn');
const walletResetBtnMobile = document.getElementById('wallet-reset-btn-mobile');

// --- Address Search State ---
// false = suffix/right-to-left (default, type ending), true = prefix/left-to-right (type beginning)
let addressSearchDirection = false; 
let walletAddressSearchDirection = false;
let walletLast4SearchMode = 'ltr';
let walletMobileSearchMode = 'full';


// --- Config ---
const METADATA_URL = "/assets/nft-metadata/all_nfts_metadata.json";  // served from this repo (Vercel edge-cached); was jsDelivr → defipatriot/nft-metadata
const STATUS_DATA_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/nfts.json";

// Canonical rarity files (/assets/nft-metadata/, migrated from defipatriot 2026-08-09) — ranks come ONLY from these.
const RARITY_INTENDED_URL = "/assets/nft-metadata/adao-rarity-intended.json";
const RARITY_BBL_URL = "/assets/nft-metadata/adao-rarity-bbl.json";
// Active rank system: 'intended' (default) or 'bbl'. Persisted per session.
let rankMode = sessionStorage.getItem('adao_rank_mode') === 'bbl' ? 'bbl' : 'intended';
let bblRarityBuilt = null; // BBL file top-level `built` — "last time BBL ranks moved"
// Active-rank accessor honoring the toggle. BBL leaves most broken NFTs unranked (null).
const getActiveRank = (nft) => rankMode === 'bbl' ? (nft.bbl_rank ?? null) : (nft.intended_rank ?? null);
// Rank display string per spec: grade stays visible in both modes; the rank is what switches.
const rankDisplay = (nft) => {
    const grade = nft.rarityClass ?? '—';
    const r = getActiveRank(nft);
    return r == null ? `Rarity ${grade}, Unranked` : `Rarity ${grade}, Rank ${r}`;
};
const MEMBERS_CSV_URL = "https://raw.githubusercontent.com/thealliancedao/dao-originations/main/adao/governance/members.csv";
const DAO_WALLET_ADDRESS = "terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm";
const EXPECTED_TOTAL_NFTS = 10000; // Fixed collection size — used to hard-fail on a truncated/partial feed.

// Known DAO / system contract addresses (verified against live chain-of-truth data).
// These are NOT holders — they're labeled in the holders dropdown so it's clear.
// The small ...8ywv wallet is intentionally left unlabeled.
const SYSTEM_WALLET_LABELS = {
    "terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm": "DAO Unminted",
    "terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v": "DAO Broken",
    "terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv": "DAO Broken Enterprise",
    "terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv": "DAO Multisig Vetoer"
};

// DAO custody wallets shown as pinned informational rows on the Holder Leaderboard.
// They stay EXCLUDED from the numbered ranks (only real users rank) but their holdings
// are displayed for data precision. Marketplace escrows / staking contracts stay hidden.
const DAO_DISPLAY_WALLETS = [
    "terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v", // DAO treasury (broken)
    "terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv", // old Enterprise staking (DAO broken)
    "terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv", // multisig vetoer
    "terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm"  // DAO main wallet (unminted)
];
const isDaoDisplayWallet = (address) => DAO_DISPLAY_WALLETS.includes(address);

const getSystemWalletLabel = (address) => SYSTEM_WALLET_LABELS[address] || null;

// All DAO/system/custody addresses — excluded from leaderboards so only real users rank.
// (DAO wallets + staking + marketplace escrow contracts; none of these are "holders" or "traders".)
const SYSTEM_ADDRESSES = new Set([
    "terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm", // DAO main wallet (unminted)
    "terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v", // DAO treasury (broken)
    "terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv", // small DAO wallet
    "terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv", // enterprise staking
    "terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47", // DAODAO staking
    "terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9", // BBL marketplace
    "terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj", // Atrium marketplace
    "terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at"  // Boost marketplace
]);
const isSystemAddress = (address) => SYSTEM_ADDRESSES.has(address);
const DAO_LOCKED_WALLET_SUFFIXES = ["8ywv", "417v", "6ugw"]; // Added from previous logic
const itemsPerPage = 20;
const traitOrder = ["Rank", "Planet", "Inhabitant", "Object", "Weather", "Light", "Rarity"];
const defaultTraitsOn = ["Rank", "Planet", "Inhabitant", "Object"];
const filterLayoutOrder = ["Rarity", "Object", "Weather", "Light"];

// --- DAO Members Lookup ---
let addressToMember = {}; // address -> { name, staked, votingPower }
let memberNames = []; // Array of member names for search

// Planet to Inhabitant mapping (for "Matching Traits" filter)
// Each planet has its native inhabitant race
const PLANET_INHABITANT_MAP = {
    'Cristall': 'Cristallian',
    'Crutha': 'Cruthan',
    'Gredica': 'Gredican',
    'Kita': 'Kitan',
    'Lusa': 'Lusan',
    'Minas': 'Minasan',
    'Ozara': 'Ozaran',
    'Pampas': 'Pampan',
    'Sindari': 'Sindarin',
    'Zando': 'Zandoan'
};

// Planet to Objects mapping (objects that belong to each planet/race)
const PLANET_OBJECTS_MAP = {
    'Cristall': ['Cristallian Staff', 'Cristallian Bow', 'Cristallian Sword', 'Cristallian Ray Gun'],
    'Crutha': ['Cruthan Death Mace', 'Cruthan Blaster'],
    'Gredica': ['Gredican Power Staff', 'Gredican Sword'],
    'Kita': ['Kitan Ice Staff', 'Kitan Ice Bow', 'Kitan Ice Sword'],
    'Lusa': ['Lusan Water Staff', 'Lusan Water Saber', 'Ancient Lusan Trident', 'Lusan Xtreme Soaker'],
    'Minas': ['Minasan Ore Staff', 'Minasan Bow', 'Minasan Ore Sword'],
    'Ozara': ['Ozaran Sand Staff', 'Ozaran Bone Axe', 'Ozaran Death Saber', 'Royal Ozaran Bow', 'Ozaran Blaster'],
    'Pampas': ['Pampan Grass Staff', 'Pampan Grass Sword'],
    'Sindari': ['Sindarin Fire Staff', 'Sindarin Fire Bow', 'Sindarin Fire Saber', 'Sindarin Flame Thrower'],
    'Zando': ['Staff of Zando', 'Sword of Zando', 'Zandoan Vine Bow']
};

// Check if an NFT has matching traits based on strictness level
// Level 0: Planet + Inhabitant match (inhabitant on home planet)
// Level 1: Planet + Inhabitant + Object match (full match - all three belong together)
const hasMatchingTraits = (nft, strictLevel = 0) => {
    const planet = nft.attributes?.find(a => a.trait_type === 'Planet')?.value;
    const inhabitant = nft.attributes?.find(a => a.trait_type === 'Inhabitant')?.value;
    const object = nft.attributes?.find(a => a.trait_type === 'Object')?.value;
    
    if (!planet || !inhabitant) return false;
    
    // Extract base planet name (remove North/South)
    const basePlanet = planet.replace(/ (North|South)$/, '');
    // Extract base inhabitant name (remove M/F)
    const baseInhabitant = inhabitant.replace(/ (M|F)$/, '');
    
    // Check if inhabitant matches planet's native race
    const planetInhabitantMatch = PLANET_INHABITANT_MAP[basePlanet] === baseInhabitant;
    
    if (!planetInhabitantMatch) return false;
    
    // If only checking planet + inhabitant (level 0), we're done
    if (strictLevel === 0) return true;
    
    // Level 1: Also check if object belongs to this planet
    if (!object) return false;
    const planetObjects = PLANET_OBJECTS_MAP[basePlanet] || [];
    return planetObjects.includes(object);
};

// --- State ---
let allNfts = [];
let filteredNfts = [];
let currentPage = 1;
let traitCounts = {};
let inhabitantCounts = {};
let planetCounts = {};
let ownerAddresses = [];
let allHolderStats = [];
let daoPinnedStats = []; // DAO custody wallets — pinned informational leaderboard rows (unranked)
let holderCurrentPage = 1;
const holdersPerPage = 10;
let holderSort = { column: 'total', direction: 'desc' };
// Map State (moved from inside function to global)
let globalAnimationFrameId;
let isMapInitialized = false;
let mapZoom = 0.15, mapRotation = 0, mapOffsetX = 0, mapOffsetY = 0;
let isPanning = false, isRotating = false;
let lastMouseX = 0, lastMouseY = 0;
let mapStars = [];
let mapObjects = [];
let isInitialLoad = true;
// NEW: Search mode state
let last4SearchMode = 'ltr'; // 'ltr' = left to right (type 7ulw), 'rtl' = right to left (type wlu7)
let mobileSearchMode = 'full'; // 'full', 'last4-ltr', 'last4-rtl', 'member'
let desktopSearchMode = 'last4-ltr'; // 'last4-ltr', 'last4-rtl', 'member'


// --- Utility Functions ---
const debounce = (func, delay) => { let timeout; return function(...args) { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), delay); }; };
const showLoading = (container, message) => { if(container) container.innerHTML = `<p class="text-center col-span-full text-cyan-400 text-lg">${message}</p>`; };
const showError = (container, message) => { if(container) container.innerHTML = `<div class="text-center col-span-full bg-red-900/50 border border-red-700 text-white p-6 rounded-lg"><h3 class="font-bold text-xl">Error</h3><p class="mt-2 text-red-300">${message}</p></div>`; };
// Primary: Cloudflare Images CDN (fast & reliable)
// Fallback: IPFS gateway
const CLOUDFLARE_CDN_BASE = 'https://imagedelivery.net/v_zOWVQCPb7Xpcbu-gQC1A/alliance_dao';
const IPFS_GATEWAY = 'https://cloudflare-ipfs.com/ipfs'; // Using Cloudflare's IPFS gateway as fallback

function getImageUrl(nftId, variant = 'public') {
    if (!nftId) return '';
    return `${CLOUDFLARE_CDN_BASE}/${nftId}.png/${variant}`;
}

function convertIpfsUrl(ipfsUrl) { 
    if (!ipfsUrl || !ipfsUrl.startsWith('ipfs://')) return ''; 
    return `${IPFS_GATEWAY}/${ipfsUrl.replace('ipfs://', '')}`; 
}

// Helper to get image with fallback - use for onerror handlers
function getIpfsFallbackUrl(nftId, ipfsUrl) {
    if (ipfsUrl && ipfsUrl.startsWith('ipfs://')) {
        return convertIpfsUrl(ipfsUrl);
    }
    return `https://placehold.co/300x300/1f2937/e5e7eb?text=NFT+${nftId || '?'}`;
}

// --- Data Fetching and Processing ---

// Parse members CSV and populate lookup maps
const fetchAndParseMembers = async () => {
    try {
        const response = await fetch(MEMBERS_CSV_URL);
        if (!response.ok) {
            console.warn('Could not fetch members CSV:', response.status);
            return;
        }
        const csvText = await response.text();
        parseMembers(csvText);
    } catch (error) {
        console.warn('Error fetching members CSV:', error);
    }
};

const parseMembers = (csvText) => {
    const lines = csvText.split('\n');
    if (lines.length < 2) return;
    
    // Skip header row, parse data rows
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse CSV with quoted fields
        const fields = parseCSVLine(line);
        if (fields.length < 5) continue;
        
        const address = fields[0].replace(/"/g, '').trim();
        const name = fields[1].replace(/"/g, '').trim();
        const staked = parseInt(fields[3].replace(/"/g, '')) || 0;
        const votingPower = parseFloat(fields[4].replace(/"/g, '')) || 0;
        
        if (address && address.startsWith('terra')) {
            addressToMember[address] = { name, staked, votingPower };
            if (name) {
                memberNames.push({ name, address, staked, votingPower });
            }
        }
    }
    
    // Sort member names alphabetically
    memberNames.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    console.log(`Loaded ${Object.keys(addressToMember).length} DAO members, ${memberNames.length} with names`);
};

// Helper to parse CSV line with quoted fields
const parseCSVLine = (line) => {
    const fields = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current);
    return fields;
};

// Helper function to get member name for an address
const getMemberName = (address) => {
    if (!address) return null;
    const member = addressToMember[address];
    return member?.name || null;
};

// Helper function to format address with member name
const formatAddressWithMember = (address, shortFormat = true) => {
    if (!address) return 'N/A';
    const memberName = getMemberName(address);
    const shortAddr = shortFormat ? `terra...${address.slice(-4)}` : address;
    if (memberName) {
        return `${memberName} (${shortAddr})`;
    }
    return shortAddr;
};

const mergeNftData = (metadata, statusData) => {
    // The v2 chain-of-truth pipeline is the ONLY status source. No deving.zone fallback,
    // no silent empty-array coercion — if records[] is missing we throw and the page fails
    // loudly rather than rendering placeholder data.
    const records = statusData && statusData.records;
    if (!Array.isArray(records)) {
        throw new Error("Status feed missing records[] — refusing to render placeholder data.");
    }
    const statusMap = new Map(records.map(r => [String(r.id), r]));

    return metadata.map(nft => {
        const status = statusMap.get(String(nft.id));
        let mergedNft = { ...nft }; // Start with metadata (attributes/traits/image)

        if (status) {
            // --- Ownership ---
            // Attribute marketplace-listed NFTs to the seller (real_owner) rather than
            // the marketplace contract. For all non-listed NFTs real_owner === owner.
            mergedNft.owner = status.real_owner || status.owner || null;
            mergedNft.custody_owner = status.owner || null; // raw on-chain holder (contract for listed/staked)
            mergedNft.real_owner = status.real_owner || status.owner || null;
            mergedNft.broken = !!status.broken;

            // --- Classification (corrected v2 flags; legacy aliases as fallback) ---
            mergedNft.staked_daodao = !!(status.daodao_staked ?? status.daodao);
            // FIX: "Staked on Enterprise" now reflects REAL user stakes (~403), not the
            // ~898 treasury NFTs that the old deving.zone feed conflated into `enterprise`.
            mergedNft.staked_enterprise_legacy = !!status.enterprise_staked;
            mergedNft.bbl_market = !!(status.bbl_listed ?? status.bbl);
            mergedNft.boost_market = !!(status.boost_listed ?? status.boost);
            mergedNft.atrium_market = !!status.atrium_listed; // NEW marketplace (badge wired in Pass 2)

            // --- New v2 classifications (carried now, surfaced in Pass 2 UI) ---
            mergedNft.unminted = !!status.unminted;
            mergedNft.treasury_held = !!status.treasury_held;
            mergedNft.dao_wallet_8ywv_held = !!status.dao_wallet_8ywv_held;
            mergedNft.enterprise_dao_broken = !!status.enterprise_dao_broken;
            mergedNft.listing = status.listing || null; // listing object incl. price_usd when an active listing exists
            mergedNft.daodao_pending_claim = !!status.daodao_pending_claim; // unstaked, in claim window

            // --- Derived ---
            // "Owned by DAO" = unminted main-wallet supply + treasury contract + small locked wallet.
            mergedNft.owned_by_alliance_dao = !!(status.unminted || status.treasury_held || status.dao_wallet_8ywv_held || status.dao);
            // liquid = freely held by a user (cron-authoritative user_held flag).
            mergedNft.liquid = !!status.user_held;
        } else {
            // No status record for this token id — safe defaults.
            mergedNft.owner = null;
            mergedNft.custody_owner = null;
            mergedNft.real_owner = null;
            mergedNft.broken = false;
            mergedNft.staked_daodao = false;
            mergedNft.staked_enterprise_legacy = false;
            mergedNft.bbl_market = false;
            mergedNft.boost_market = false;
            mergedNft.atrium_market = false;
            mergedNft.unminted = false;
            mergedNft.treasury_held = false;
            mergedNft.dao_wallet_8ywv_held = false;
            mergedNft.enterprise_dao_broken = false;
            mergedNft.listing = null;
            mergedNft.owned_by_alliance_dao = false;
            mergedNft.liquid = true;
        }
        return mergedNft;
    });
};

const initializeExplorer = async () => {
    showLoading(gallery, 'Loading collection metadata...');
    showLoading(leaderboardTable, 'Loading holder data...');
    showLoading(walletGallery, 'Search for or select a wallet to see owned NFTs.');
    try {
        // Fetch all data in parallel (members CSV is non-critical, won't block on error)
        const [metaResponse, statusResponse, rarityIntendedResponse, rarityBblResponse] = await Promise.all([
            fetch(METADATA_URL),
            fetch(STATUS_DATA_URL),
            fetch(RARITY_INTENDED_URL),
            fetch(RARITY_BBL_URL),
            fetchAndParseMembers() // Load DAO members (non-blocking)
        ]);

        if (!metaResponse.ok) throw new Error(`Metadata network response was not ok: ${metaResponse.status}`);
        if (!statusResponse.ok) throw new Error(`Status data network response was not ok: ${statusResponse.status}`);
        if (!rarityIntendedResponse.ok) throw new Error(`Intended-rarity feed was not ok: ${rarityIntendedResponse.status}`);
        if (!rarityBblResponse.ok) throw new Error(`BBL-rarity feed was not ok: ${rarityBblResponse.status}`);
        
        const metadata = await metaResponse.json();
        const statusData = await statusResponse.json();
        const rarityIntended = await rarityIntendedResponse.json();
        const rarityBbl = await rarityBblResponse.json();

        // Hard-fail integrity gate: good data or a visible error, nothing in between.
        if (!Array.isArray(metadata) || metadata.length === 0) {
            throw new Error("Metadata feed is empty or malformed.");
        }
        const statusRecords = statusData && statusData.records;
        if (!Array.isArray(statusRecords) || statusRecords.length < EXPECTED_TOTAL_NFTS) {
            throw new Error(`Status feed failed integrity check: expected ${EXPECTED_TOTAL_NFTS} records, got ${Array.isArray(statusRecords) ? statusRecords.length : 'none'}.`);
        }

        allNfts = mergeNftData(metadata, statusData);

        // --- Canonical rarity join (ranks come ONLY from these files) ---
        const intendedRecords = rarityIntended && rarityIntended.records;
        const bblRecords = rarityBbl && rarityBbl.records;
        if (!Array.isArray(intendedRecords) || intendedRecords.length < EXPECTED_TOTAL_NFTS) {
            throw new Error(`Intended-rarity feed failed integrity check: expected ${EXPECTED_TOTAL_NFTS} records, got ${Array.isArray(intendedRecords) ? intendedRecords.length : 'none'}.`);
        }
        if (!Array.isArray(bblRecords) || bblRecords.length < EXPECTED_TOTAL_NFTS) {
            throw new Error(`BBL-rarity feed failed integrity check: expected ${EXPECTED_TOTAL_NFTS} records, got ${Array.isArray(bblRecords) ? bblRecords.length : 'none'}.`);
        }
        bblRarityBuilt = rarityBbl.built || null;
        const intendedMap = new Map(intendedRecords.map(r => [String(r.token_id), r]));
        const bblMap = new Map(bblRecords.map(r => [String(r.token_id), r]));
        allNfts.forEach(nft => {
            const ir = intendedMap.get(String(nft.id));
            const br = bblMap.get(String(nft.id));
            nft.intended_rank = ir ? ir.intended_rank : null;
            nft.intended_grade = ir ? ir.grade : null;
            nft.bbl_rank = br ? br.bbl_rank : null;          // null = BBL unranked (mostly broken)
            nft.bbl_top_percent = br ? br.bbl_top_percent : null;
        });
        const rankedCount = allNfts.filter(n => n.intended_rank != null).length;
        if (rankedCount < EXPECTED_TOTAL_NFTS) {
            throw new Error(`Rarity join incomplete: only ${rankedCount}/${EXPECTED_TOTAL_NFTS} NFTs received an intended rank.`);
        }

        // Every NFT must resolve to an owner via the pipeline; a shortfall means a corrupt/partial feed.
        const resolvedCount = allNfts.filter(nft => nft.owner).length;
        if (resolvedCount < EXPECTED_TOTAL_NFTS) {
            throw new Error(`Status merge incomplete: only ${resolvedCount}/${EXPECTED_TOTAL_NFTS} NFTs resolved to an owner.`);
        }
        ownerAddresses = [...new Set(allNfts.map(nft => nft.owner).filter(Boolean))]; // Populate master list

        calculateRanks();
        populateTraitFilters();
        populateInhabitantFilters();
        populatePlanetFilters();
        populateStatusFilters();
        renderMarketplaceChips();   // built from live data — hides empty marketplaces
        populateTraitToggles();
        populateWalletTraitToggles();
        updateAddressDropdown(allNfts);
        updateFilterCounts(allNfts);
        updateMatchingTraitsCount(); // Update matching traits count
        addAllEventListeners();
        applyStateFromUrl();
        const initialView = new URLSearchParams(window.location.search).get('view');
        if (['analytics', 'wallet', 'map'].includes(initialView)) switchView(initialView, true);
        applyFiltersAndSort();
        calculateAndDisplayLeaderboard();
        
        
        handleHashChange(); // Check hash on initial load
        isInitialLoad = false; // Mark initial load complete

    } catch (error) {
        console.error("Failed to initialize explorer:", error);
        showError(gallery, `Could not load or process NFT data. Error: ${error.message}`);
        showError(leaderboardTable, 'Could not load data.');
        showError(walletGallery, 'Could not load data.');
    }
};

const calculateRanks = () => {
    traitCounts = {};
    inhabitantCounts = {};
    planetCounts = {};
    
    // First pass: count all traits
    allNfts.forEach(nft => {
        if (nft.attributes) {
            nft.attributes.forEach(attr => {
                if (!traitCounts[attr.trait_type]) traitCounts[attr.trait_type] = {};
                traitCounts[attr.trait_type][attr.value] = (traitCounts[attr.trait_type][attr.value] || 0) + 1;
                
                if (attr.trait_type === 'Inhabitant') {
                    const baseName = attr.value.replace(/ (M|F)$/, '');
                    if (!inhabitantCounts[baseName]) inhabitantCounts[baseName] = { total: 0, male: 0, female: 0 };
                    inhabitantCounts[baseName].total++;
                    if (attr.value.endsWith(' M')) inhabitantCounts[baseName].male++;
                    if (attr.value.endsWith(' F')) inhabitantCounts[baseName].female++;
                }
                if (attr.trait_type === 'Planet') {
                    const baseName = attr.value.replace(/ (North|South)$/, '');
                    if (!planetCounts[baseName]) planetCounts[baseName] = { total: 0, north: 0, south: 0 };
                    planetCounts[baseName].total++;
                    if (attr.value.endsWith(' North')) planetCounts[baseName].north++;
                    if (attr.value.endsWith(' South')) planetCounts[baseName].south++;
                }
            });
        }
    });

    // Second pass: per-NFT trait values/counts (still used by trait filters, medals, matching checks).
    // NOTE: ranks are NOT derived here anymore — intended_rank / bbl_rank come only from the
    // canonical files in /assets/nft-metadata (joined in initializeExplorer). The old
    // within-grade tie-break sort + subRank (source of the "40/1" display) is retired.
    allNfts.forEach(nft => {
        // Grade (1-40): canonical intended file is authoritative; metadata Rarity attr as fallback.
        const officialRarity = nft.attributes?.find(a => a.trait_type === 'Rarity')?.value || 0;
        nft.rarityClass = nft.intended_grade ?? Number(officialRarity);
        
        // Get individual trait values
        const inhabitantValue = nft.attributes?.find(a => a.trait_type === 'Inhabitant')?.value;
        const planetValue = nft.attributes?.find(a => a.trait_type === 'Planet')?.value;
        const weatherValue = nft.attributes?.find(a => a.trait_type === 'Weather')?.value;
        const lightValue = nft.attributes?.find(a => a.trait_type === 'Light')?.value;
        
        // For Inhabitant: use the specific M/F variant count, not the base count
        nft.inhabitantCount = inhabitantValue ? (traitCounts['Inhabitant']?.[inhabitantValue] || 9999) : 9999;
        
        // For Planet: use the specific North/South variant count
        nft.planetCount = planetValue ? (traitCounts['Planet']?.[planetValue] || 9999) : 9999;
        
        // Weather and Light counts
        nft.weatherCount = weatherValue ? (traitCounts['Weather']?.[weatherValue] || 9999) : 9999;
        nft.lightCount = lightValue ? (traitCounts['Light']?.[lightValue] || 9999) : 9999;
        
        // Store the values for display/debugging
        nft.inhabitantValue = inhabitantValue;
        nft.planetValue = planetValue;
        nft.weatherValue = weatherValue;
        nft.lightValue = lightValue;
    });

    // Base order: canonical intended rank ascending (rank 1 = best, first).
    allNfts.sort((a, b) => (a.intended_rank ?? Infinity) - (b.intended_rank ?? Infinity));
};

// Helper function to get trait rarity rank (for medal display)
const getTraitRarityRank = (traitType, traitValue) => {
    if (!traitCounts[traitType]) return null;
    
    // Get all values for this trait type and sort by count (ascending = rarer first)
    const traitValues = Object.entries(traitCounts[traitType])
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.count - b.count);
    
    const rank = traitValues.findIndex(t => t.value === traitValue) + 1;
    const total = traitValues.length;
    const count = traitCounts[traitType][traitValue];
    const percentage = ((count / allNfts.length) * 100).toFixed(1);
    
    return { rank, total, count, percentage };
};

// Populate the distribution tables in the Sorting Explained modal
const populateDistributionTables = () => {
    const planetDistEl = document.getElementById('planet-distribution');
    const inhabitantDistEl = document.getElementById('inhabitant-distribution');
    
    if (!traitCounts['Planet'] || !traitCounts['Inhabitant']) {
        if (planetDistEl) planetDistEl.innerHTML = '<p class="text-gray-500">Data not loaded yet.</p>';
        if (inhabitantDistEl) inhabitantDistEl.innerHTML = '<p class="text-gray-500">Data not loaded yet.</p>';
        return;
    }
    
    // Planet + Zone distribution (sorted by count, rarest first)
    if (planetDistEl) {
        const planetData = Object.entries(traitCounts['Planet'])
            .map(([name, count]) => ({ name, count, pct: ((count / allNfts.length) * 100).toFixed(2) }))
            .sort((a, b) => a.count - b.count);
        
        let html = '<div class="grid grid-cols-2 md:grid-cols-4 gap-2">';
        planetData.forEach((p, idx) => {
            const colorClass = idx < 5 ? 'text-yellow-400' : idx < 10 ? 'text-cyan-400' : 'text-gray-400';
            html += `<span class="${colorClass}">${idx + 1}. ${p.name} (${p.count} - ${p.pct}%)</span>`;
        });
        html += '</div>';
        planetDistEl.innerHTML = html;
    }
    
    // Inhabitant + Gender distribution (sorted by count, rarest first)
    if (inhabitantDistEl) {
        const inhabitantData = Object.entries(traitCounts['Inhabitant'])
            .map(([name, count]) => ({ name, count, pct: ((count / allNfts.length) * 100).toFixed(2) }))
            .sort((a, b) => a.count - b.count);
        
        let html = '<div class="grid grid-cols-2 md:grid-cols-4 gap-2">';
        inhabitantData.forEach((i, idx) => {
            const colorClass = idx < 5 ? 'text-purple-400' : idx < 10 ? 'text-cyan-400' : 'text-gray-400';
            html += `<span class="${colorClass}">${idx + 1}. ${i.name} (${i.count} - ${i.pct}%)</span>`;
        });
        html += '</div>';
        inhabitantDistEl.innerHTML = html;
    }
};

// Update the matching traits count display
const updateMatchingTraitsCount = () => {
    if (!allNfts.length) return;
    
    // Get the slider using attribute selector (works regardless of class names)
    const slider = document.querySelector('[data-slider-key="matching_traits"]') || matchingTraitsSlider;
    const strictLevel = slider ? parseInt(slider.value) : 1; // Default to 1 (P+I+O)
    
    // Count for current level
    const count = allNfts.filter(nft => hasMatchingTraits(nft, strictLevel)).length;
    
    // Update dynamic count display (above the slider)
    const dynamicCount = document.querySelector('[data-count-key="matching_traits"]');
    if (dynamicCount) {
        dynamicCount.textContent = count.toLocaleString();
    }
    
    // Also update old hardcoded element if exists
    if (matchingTraitsCount) {
        matchingTraitsCount.textContent = count.toLocaleString();
    }
};

// --- UI Population ---
// =============================================================================
// MARKETPLACES (2026-08-12) — one registry, used by the filter chips, the card
// badges and the detail view. Adding a fourth marketplace = one entry here.
// Previously BBL/Boost were hardcoded in three places and Atrium — 18 live
// listings — was captured by the cron but invisible everywhere in the UI.
// =============================================================================
const MARKETPLACES = [
    { key: 'bbl',    label: 'BBL',    field: 'bbl_market',    icon: '/assets/images/BBL%20No%20Background.png' },
    // No Atrium logo in /assets/images yet (verified 404 on 2026-08-12), so this
    // falls back to a text badge. Drop an "Atrium Logo.png" in that folder and
    // the image badge starts working automatically — no code change needed.
    // Atrium's own favicon (SVG). Kept remote deliberately: no local asset
    // exists, and the letter-badge fallback still fires if it ever fails.
    { key: 'atrium', label: 'Atrium', field: 'atrium_market', icon: 'https://atrium.markets/img/atrium-favicon.svg', letter: 'A' },
    { key: 'boost',  label: 'Boost',  field: 'boost_market',  icon: '/assets/images/Boost%20Logo.png' },
];
// Which marketplaces are currently switched on in the Listed filter. Rebuilt
// from live data each render — a marketplace with zero listings never appears.
let activeMarketplaces = new Set(MARKETPLACES.map(m => m.key));

const marketplaceOf = (nft) => {
    const m = MARKETPLACES.find(x => nft[x.field]);
    return m ? m.label : (nft.listing && nft.listing.marketplace) || null;
};

// Listing price, formatted honestly:
//   "2,500 bLUNA" with "~$187" beside it. Denominations genuinely differ per
//   marketplace (bLUNA / SOLID / LUNA), so the USD figure is what makes two
//   listings comparable — and it is what we sort on.
const fmtListingPrice = (listing) => {
    if (!listing) return null;
    // NB: price_display ALREADY carries the symbol ("2,500 bLUNA"). Appending
    // price_token_symbol on top of it duplicated it ("2,500 bLUNA bLUNA") —
    // caught by the live-data gate. Only add the symbol when we fall back to
    // the raw numeric amount.
    const sym = listing.price_token_symbol || '';
    let amt = listing.price_display || null;
    if (!amt && listing.price_amount != null) {
        amt = Number(listing.price_amount).toLocaleString(undefined, { maximumFractionDigits: 4 })
            + (sym ? ' ' + sym : '');
    }
    if (!amt) return { token: null, usd: null, text: 'No price set' };
    const usd = (listing.price_usd != null && isFinite(listing.price_usd))
        ? '$' + Number(listing.price_usd).toLocaleString(undefined, { maximumFractionDigits: 2 })
        : null;
    return { token: amt, usd, text: amt };
};

 const createFilterItem = (config) => {
    const container = document.createElement('div');
    container.className = 'flex items-center justify-between';
    if (config.tooltip) container.title = config.tooltip; // native hover tooltip
    
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle-label';
    toggleLabel.innerHTML = `<input type="checkbox" class="toggle-checkbox ${config.toggleClass}" data-key="${config.key}"><span class="toggle-switch mr-2"></span><span class="font-medium">${config.label}</span>`;
    
    // For matching_traits, use only 2 positions (0 and 1), default to 1 (right)
    const isMatchingTraits = config.key === 'matching_traits';
    const sliderMin = 0;
    const sliderMax = isMatchingTraits ? 1 : 2;
    const sliderDefault = isMatchingTraits ? 1 : 1; // Default to right for matching traits
    
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'flex flex-col items-center';
    sliderContainer.innerHTML = `<span class="text-xs text-gray-400 h-4 ${config.countClass || ''}" data-count-key="${config.key}">${config.initialCount || ''}</span><div class="direction-slider-container"><span class="text-xs text-gray-400">${config.left}</span><input type="range" min="${sliderMin}" max="${sliderMax}" value="${sliderDefault}" class="direction-slider ${config.sliderClass}" data-slider-key="${config.key}" disabled><span class="text-xs text-gray-400">${config.right}</span></div>`;
    
    container.appendChild(toggleLabel);
    // MARKETPLACE CHIPS (2026-08-12): a 3-position slider can express
    // "Boost | Both | BBL" but cannot express three marketplaces, and cannot
    // express "BBL + Boost but not Atrium". Independent chips can, and they
    // scale if a fourth marketplace ever appears. Built dynamically in
    // renderMarketplaceChips() from live data.
    if (config.chips) {
        const chipWrap = document.createElement('div');
        chipWrap.className = 'flex flex-col items-end';
        chipWrap.innerHTML = `<span class="text-xs text-gray-400 h-4 ${config.countClass || ''}" data-count-key="${config.key}">${config.initialCount || ''}</span>`
            + `<div class="marketplace-chips flex flex-wrap gap-1 justify-end" id="marketplace-chips"></div>`;
        container.appendChild(chipWrap);
        return container;
    }
    container.appendChild(sliderContainer);
    return container;
};

// Rebuilt whenever data loads: a marketplace with zero live listings is not
// shown at all, so the row honestly reflects where listings actually are.
const renderMarketplaceChips = () => {
    const host = document.getElementById('marketplace-chips');
    if (!host) return;
    const counts = {};
    for (const m of MARKETPLACES) counts[m.key] = allNfts.filter(n => n[m.field]).length;
    const present = MARKETPLACES.filter(m => counts[m.key] > 0);

    // Drop any marketplace that no longer has listings from the active set,
    // and make sure a newly-appearing one starts switched on.
    for (const m of MARKETPLACES) {
        if (counts[m.key] === 0) activeMarketplaces.delete(m.key);
        else if (!activeMarketplaces.has(m.key) && !host.dataset.userTouched) activeMarketplaces.add(m.key);
    }
    if (!present.length) {
        host.innerHTML = '<span class="text-xs text-gray-500">no live listings</span>';
        return;
    }
    host.innerHTML = present.map(m => {
        const on = activeMarketplaces.has(m.key);
        return `<button type="button" class="mk-chip text-xs px-2 py-0.5 rounded border transition-colors ${on
            ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200'
            : 'bg-transparent border-gray-600 text-gray-500'}" data-mk="${m.key}"
            title="${on ? 'Showing' : 'Hidden'} — ${m.label}: ${counts[m.key]} listed">${m.label} ${counts[m.key]}</button>`;
    }).join('');

    host.querySelectorAll('.mk-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            const k = btn.dataset.mk;
            host.dataset.userTouched = '1';
            if (activeMarketplaces.has(k)) {
                // Never let the user switch every marketplace off — that would
                // silently show zero results with the Listed filter on.
                if (activeMarketplaces.size > 1) activeMarketplaces.delete(k);
            } else activeMarketplaces.add(k);
            renderMarketplaceChips();
            applyFiltersAndSort();
        });
    });
};

const populateInhabitantFilters = () => {
    inhabitantFiltersContainer.innerHTML = '';
    const uniqueInhabitants = Object.keys(inhabitantCounts).sort();
    uniqueInhabitants.forEach(name => {
        const container = createFilterItem({
            toggleClass: 'inhabitant-toggle-cb', key: name, label: name,
            countClass: 'inhabitant-count', initialCount: inhabitantCounts[name].total,
            sliderClass: 'gender-slider', left: 'M', right: 'F'
        });
        inhabitantFiltersContainer.appendChild(container);
        container.addEventListener('mouseenter', (e) => showPreviewTile(e, 'Inhabitant', name));
        container.addEventListener('mouseleave', hidePreviewTile);
    });
};

const populatePlanetFilters = () => {
    planetFiltersContainer.innerHTML = '';
    const planetNames = Object.keys(planetCounts).sort();
    planetNames.forEach(name => {
        const container = createFilterItem({
            toggleClass: 'planet-toggle-cb', key: name, label: name,
            countClass: 'planet-count', initialCount: planetCounts[name].total,
            sliderClass: 'planet-slider', left: 'N', right: 'S'
        });
        planetFiltersContainer.appendChild(container);
        container.addEventListener('mouseenter', (e) => showPreviewTile(e, 'Planet', name));
        container.addEventListener('mouseleave', hidePreviewTile);
    });
};

const populateTraitFilters = () => {
    traitFiltersContainer.innerHTML = '';

    const createMultiSelect = (traitType, values) => {
        const container = document.createElement('div');
        container.className = 'multi-select-container';
        let optionsHtml = '';
        values.forEach(value => {
            const style = value === 'Phoenix Rising' ? 'style="color: #f97316; font-weight: bold;"' : '';
            optionsHtml += `<label ${style}><input type="checkbox" class="multi-select-checkbox" data-trait="${traitType}" value="${value}"> <span class="trait-value">${value}</span> (<span class="trait-count">0</span>)</label>`;
        });
        const displayLabel = traitType === 'Rarity' ? 'Rank' : traitType; // grade dropdown shown as "Rank" (filters by 1-40 grade)
        container.innerHTML = `<label class="block text-sm font-medium text-gray-300 mb-1">${displayLabel}</label><button type="button" class="multi-select-button"><span>All ${displayLabel}s</span><svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg></button><div class="multi-select-dropdown hidden">${optionsHtml}</div>`;
        const button = container.querySelector('.multi-select-button');
        const dropdown = container.querySelector('.multi-select-dropdown');
        button.addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(dropdown); dropdown.classList.toggle('hidden'); });
        dropdown.addEventListener('change', () => { updateMultiSelectButtonText(container); handleFilterChange(); });

        if (traitType === 'Object') {
            dropdown.querySelectorAll('label').forEach(label => {
                const checkbox = label.querySelector('input');
                if (checkbox) { // Ensure checkbox exists
                    label.addEventListener('mouseenter', (e) => showPreviewTile(e, 'Object', checkbox.value));
                    label.addEventListener('mouseleave', hidePreviewTile);
                }
            });
        }
        return container;
    };

    filterLayoutOrder.forEach(traitType => {
        let values;
        if (traitType === 'Rarity') {
            values = Object.keys(traitCounts[traitType] || {}).sort((a, b) => Number(b) - Number(a));
        } else {
             values = Object.keys(traitCounts[traitType] || {}).sort();
        }
        
        if (traitType === 'Object' || traitType === 'Weather' || traitType === 'Light') {
            values.sort((a, b) => (traitCounts[traitType]?.[a] || 0) - (traitCounts[traitType]?.[b] || 0));
        }
        if (traitType === 'Object') {
            const phoenixIndex = values.indexOf('Phoenix Rising');
            if (phoenixIndex > -1) { const [phoenixRising] = values.splice(phoenixIndex, 1); values.unshift(phoenixRising); }
        }
        traitFiltersContainer.appendChild(createMultiSelect(traitType, values));
    });
};

const populateStatusFilters = () => {
    statusFiltersGrid.innerHTML = '';
    
    // All 6 status filters in the same structure
    const statusFilterConfig = [
        { key: 'staked', label: 'Staked', left: 'Ent', right: 'DAO' },
        { key: 'listed', label: 'Listed', chips: true, tooltip: 'Filter by marketplace. Only marketplaces with live listings appear; each toggles independently, so any combination works.' },
        { key: 'rewards', label: 'Rewards', left: 'Broken', right: 'Unbroken' },
        { key: 'mint_status', label: 'Mint Status', left: 'Un-Minted', right: 'Minted' },
        { key: 'matching_traits', label: 'Matching', left: 'P+I', right: 'P+I+O', tooltip: 'Home-system trait match \u2014 P+I: the Inhabitant is standing on its home planet (e.g. a Lusan on Lusa). P+I+O: planet + inhabitant + a native object of that world (e.g. Lusan Water Staff). Slide to choose which match the count shows.' },
        { key: 'liquid_status', label: 'Liquid', left: 'Liquid', right: 'Not Liq' }
    ];

    statusFilterConfig.forEach(filter => {
        const container = createFilterItem({
            toggleClass: 'status-toggle-cb', 
            key: filter.key, 
            label: filter.label,
            countClass: 'status-count',
            sliderClass: 'status-slider', 
            left: filter.left, 
            right: filter.right,
            // BUG FIX 2026-08-12: this forEach rebuilds a fresh config object and
            // only copied a fixed set of keys, so `chips` never reached
            // createFilterItem — the Listed row fell through to the slider branch
            // and rendered "undefined … undefined" (its left/right were removed
            // when it became chip-based). Pass the flag through.
            chips: filter.chips,
            tooltip: filter.tooltip
        });
        statusFiltersGrid.appendChild(container);
    });

    // Clear and hide the old extra container since we moved everything to the main grid
    const extraContainer = document.getElementById('status-filters-extra');
    if (extraContainer) {
        extraContainer.style.display = 'none';
    }
};

const populateTraitToggles = () => {
    traitTogglesContainer.innerHTML = '';
    traitOrder.forEach(traitType => {
        const label = document.createElement('label');
        label.className = 'toggle-label';
        label.innerHTML = `<input type="checkbox" class="toggle-checkbox trait-toggle" data-trait="${traitType}" ${defaultTraitsOn.includes(traitType) ? 'checked' : ''}><span class="toggle-switch mr-2"></span><span>${traitType}</span>`;
        traitTogglesContainer.appendChild(label);
    });
};

const populateWalletTraitToggles = () => {
    walletTraitTogglesContainer.innerHTML = '';
    const walletTraits = ["Rank", "Planet", "Inhabitant", "Object"];
    walletTraits.forEach(traitType => {
        const label = document.createElement('label');
        label.className = 'toggle-label';
        label.innerHTML = `<input type="checkbox" class="toggle-checkbox wallet-trait-toggle" data-trait="${traitType}" checked><span class="toggle-switch mr-2"></span><span>${traitType}</span>`;
        walletTraitTogglesContainer.appendChild(label);
    });
};

const addAllEventListeners = () => {
    // --- Rank-system toggle (Intended / BBL) ---
    const rankModeIntendedBtn = document.getElementById('rank-mode-intended');
    const rankModeBblBtn = document.getElementById('rank-mode-bbl');
    const bblDisclaimer = document.getElementById('bbl-rank-disclaimer');
    const applyRankModeUi = () => {
        if (rankModeIntendedBtn) rankModeIntendedBtn.classList.toggle('active', rankMode === 'intended');
        if (rankModeBblBtn) rankModeBblBtn.classList.toggle('active', rankMode === 'bbl');
        if (bblDisclaimer) {
            if (rankMode === 'bbl') {
                const builtDate = bblRarityBuilt ? new Date(bblRarityBuilt).toISOString().slice(0, 10) : 'unknown';
                bblDisclaimer.textContent = `BBL ranks mirrored from BackBone Labs · last changed ${builtDate} · BBL leaves most broken NFTs unranked.`;
                bblDisclaimer.classList.remove('hidden');
            } else {
                bblDisclaimer.classList.add('hidden');
            }
        }
    };
    const setRankMode = (mode) => {
        if (mode === rankMode) return;
        rankMode = mode;
        sessionStorage.setItem('adao_rank_mode', mode);
        applyRankModeUi();
        applyFiltersAndSort();           // re-sorts (rank-aware) and re-renders every visible card
        if (typeof renderWalletResults === 'function') { /* wallet re-renders on next interaction */ }
    };
    if (rankModeIntendedBtn) rankModeIntendedBtn.addEventListener('click', () => setRankMode('intended'));
    if (rankModeBblBtn) rankModeBblBtn.addEventListener('click', () => setRankMode('bbl'));
    applyRankModeUi(); // restore persisted mode on load

     document.querySelectorAll('.toggle-checkbox').forEach(toggle => {
        toggle.addEventListener('change', (e) => {
            const parent = e.target.closest('.justify-between');
            if (!parent) return;
            const slider = parent.querySelector('.direction-slider');
            if (slider) {
                slider.disabled = !e.target.checked;
            }
            // Update matching traits count if this is the matching traits toggle
            if (e.target.dataset.key === 'matching_traits') {
                updateMatchingTraitsCount();
            }
            handleFilterChange();
        });
    });
    
    // Debounce slider input to prevent rapid-fire on mobile touch
    let sliderDebounceTimeout = null;
    const debouncedSliderChange = (slider) => {
        if (sliderDebounceTimeout) clearTimeout(sliderDebounceTimeout);
        sliderDebounceTimeout = setTimeout(() => {
            if (slider.dataset.sliderKey === 'matching_traits') {
                updateMatchingTraitsCount();
            }
            handleFilterChange();
        }, 50);
    };
    
    document.querySelectorAll('.direction-slider').forEach(slider => {
        slider.addEventListener('input', () => debouncedSliderChange(slider));
        slider.addEventListener('change', () => debouncedSliderChange(slider));
    });
    document.querySelectorAll('.trait-toggle').forEach(el => el.addEventListener('change', () => displayPage(currentPage)));
    // Note: multi-select-checkbox listeners are added in populateTraitFilters
    
    if (addressDropdown) {
        addressDropdown.addEventListener('change', () => {
            searchAddressInput.value = addressDropdown.value;
            handleFilterChange();
        });
    }
    
    if (walletTraitTogglesContainer) {
        walletTraitTogglesContainer.addEventListener('change', (e) => {
            if (e.target.classList.contains('wallet-trait-toggle')) {
                searchWallet(); // Re-render gallery with new toggle settings
            }
        });
    }
    
    // *** ADDED EVENT LISTENERS FOR COLLAPSIBLE SECTIONS ***
    if(togInhabBtn && inhabitantFiltersContainer && inhabArrow) {
        togInhabBtn.addEventListener('click', () => {
            inhabitantFiltersContainer.classList.toggle('hidden');
            inhabArrow.classList.toggle('rotate-180');
        });
    }
    if(togPlanBtn && planetFiltersContainer && planArrow) {
        togPlanBtn.addEventListener('click', () => {
            planetFiltersContainer.classList.toggle('hidden');
            planArrow.classList.toggle('rotate-180');
        });
    }
    // Status filters toggle - same behavior as inhabitant/planet
    if(togStatusBtn && statusFiltersGrid && statusArrow) {
        togStatusBtn.addEventListener('click', () => {
            statusFiltersGrid.classList.toggle('hidden');
            statusArrow.classList.toggle('rotate-180');
        });
    }
    
    // Add other listeners from the single file
    document.addEventListener('click', () => closeAllDropdowns());
    if (modalCloseBtn) modalCloseBtn.addEventListener('click', hideNftDetails);
    if (nftModal) nftModal.addEventListener('click', (e) => { if (e.target === nftModal) hideNftDetails(); });
    if (rarityExplainedBtn) rarityExplainedBtn.addEventListener('click', () => rarityModal.classList.remove('hidden'));
    if (rarityModalCloseBtn) rarityModalCloseBtn.addEventListener('click', () => rarityModal.classList.add('hidden'));
    if (rarityModal) rarityModal.addEventListener('click', (e) => { if (e.target === rarityModal) rarityModal.classList.add('hidden'); });
    if (sortingExplainedBtn) sortingExplainedBtn.addEventListener('click', () => { 
        populateDistributionTables(); 
        sortingModal.classList.remove('hidden'); 
    });
    if (sortingModalCloseBtn) sortingModalCloseBtn.addEventListener('click', () => sortingModal.classList.add('hidden'));
    if (sortingModal) sortingModal.addEventListener('click', (e) => { if (e.target === sortingModal) sortingModal.classList.add('hidden'); });
    if (badgesExplainedBtn) badgesExplainedBtn.addEventListener('click', () => badgeModal.classList.remove('hidden'));
    if (badgeModalCloseBtn) badgeModalCloseBtn.addEventListener('click', () => badgeModal.classList.add('hidden'));
    if (badgeModal) badgeModal.addEventListener('click', (e) => { if (e.target === badgeModal) badgeModal.classList.add('hidden'); });
    if (matchingTraitsToggle) {
        matchingTraitsToggle.addEventListener('change', () => {
            if (matchingTraitsSlider) {
                matchingTraitsSlider.disabled = !matchingTraitsToggle.checked;
            }
            updateMatchingTraitsCount();
            handleFilterChange();
        });
    }
    if (matchingTraitsSlider) {
        matchingTraitsSlider.addEventListener('input', () => {
            updateMatchingTraitsCount();
            handleFilterChange();
        });
    }
    if (walletModalCloseBtn) walletModalCloseBtn.addEventListener('click', hideWalletExplorerModal);
    if (walletExplorerModal) walletExplorerModal.addEventListener('click', (e) => { if (e.target === walletExplorerModal) hideWalletExplorerModal(); });
    if (systemModalCloseBtn) systemModalCloseBtn.addEventListener('click', hideSystemLeaderboardModal);
    if (systemLeaderboardModal) systemLeaderboardModal.addEventListener('click', (e) => { if (e.target === systemLeaderboardModal) hideSystemLeaderboardModal(); });

    
    const debouncedFilter = debounce(handleFilterChange, 300);
    if (searchInput) searchInput.addEventListener('input', debouncedFilter);
    if (sortSelect) sortSelect.addEventListener('change', handleFilterChange);
    if (resetButton) resetButton.addEventListener('click', resetAll);
    
    window.addEventListener('popstate', () => {
        const v = new URLSearchParams(window.location.search).get('view');
        switchView(['analytics', 'wallet', 'map'].includes(v) ? v : 'collection', true);
    });
    if (collectionViewBtn) collectionViewBtn.addEventListener('click', () => switchView('collection'));
    if (analyticsViewBtn) analyticsViewBtn.addEventListener('click', () => switchView('analytics'));
    if (walletViewBtn) walletViewBtn.addEventListener('click', () => switchView('wallet'));
    if (mapViewBtn) mapViewBtn.addEventListener('click', () => switchView('map'));


    if (walletResetBtn) {
        walletResetBtn.addEventListener('click', () => {
            if (walletSearchAddressInput) walletSearchAddressInput.value = '';
            if (walletGallery) walletGallery.innerHTML = '';
            if (walletGalleryTitle) walletGalleryTitle.textContent = 'Wallet NFTs';
            // Reset wallet status filters and sliders
            document.querySelectorAll('.wallet-status-filter').forEach(cb => {
                cb.checked = false;
            });
            document.querySelectorAll('.wallet-status-slider').forEach(slider => {
                slider.disabled = true;
                slider.value = '1';
            });
            document.querySelectorAll('#leaderboard-table .leaderboard-row').forEach(row => {
                row.classList.remove('selected');
            });
            // Hide mobile wallet details popup
            const detailsContainer = document.getElementById('selected-wallet-details');
            if (detailsContainer) detailsContainer.classList.add('hidden');
            // Clear mobile search fields
            if (walletMobileSearchAddress) walletMobileSearchAddress.value = '';
            if (walletSearchLast4) walletSearchLast4.value = '';
            showLoading(walletGallery,'Search for or select a wallet to see owned NFTs.');
        });
    }
    
    // Wallet status filters - refresh display when toggled and enable/disable sliders
    // Wallet status filters - simple handler, debounced
    let walletFilterTimeout = null;
    const triggerWalletSearch = () => {
        if (walletFilterTimeout) clearTimeout(walletFilterTimeout);
        walletFilterTimeout = setTimeout(() => {
            if (walletSearchAddressInput?.value.trim()) searchWallet();
        }, 100);
    };
    
    document.querySelectorAll('.wallet-status-filter').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const status = e.target.dataset.status;
            const slider = document.querySelector(`.wallet-status-slider[data-slider-status="${status}"]`);
            if (slider) slider.disabled = !e.target.checked;
            triggerWalletSearch();
        });
    });
    
    // Wallet status sliders
    document.querySelectorAll('.wallet-status-slider').forEach(slider => {
        slider.addEventListener('input', triggerWalletSearch);
        slider.addEventListener('change', triggerWalletSearch);
    });

    if (walletSearchAddressInput) {
        walletSearchAddressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchWallet();
        });
    }
    
    if (searchAddressInput) {
        searchAddressInput.addEventListener('input', () => {
            handleAddressInput(searchAddressInput, addressSuggestions, handleFilterChange, false);
        });
    }
    
    if (walletSearchAddressInput) {
        walletSearchAddressInput.addEventListener('input', () => {
            handleAddressInput(walletSearchAddressInput, walletAddressSuggestions, searchWallet, true);
        });
    }

    if (leaderboardTable) {
        leaderboardTable.addEventListener('click', (e) => {
            const headerCell = e.target.closest('[data-sort-by]');
            if (!headerCell) return;

            const newColumn = headerCell.dataset.sortBy;
            if (holderSort.column === newColumn) {
                holderSort.direction = holderSort.direction === 'desc' ? 'asc' : 'desc';
            } else {
                holderSort.column = newColumn;
                holderSort.direction = (newColumn === 'address') ? 'asc' : 'desc'; // Default text to A-Z
            }
            sortAndDisplayHolders();
        });
    }


     const setupCopyButton = (buttonEl, inputEl) => {
         if (buttonEl && inputEl) { // Add null check
            buttonEl.addEventListener('click', () => copyToClipboard(inputEl.value));
         }
     };

    setupCopyButton(copyAddressBtn, searchAddressInput);
    setupCopyButton(walletCopyAddressBtn, walletSearchAddressInput);
    
    // Setup address direction toggles
    setupAddressDirectionToggle(addressDirectionToggle, searchAddressInput, false);
    setupAddressDirectionToggle(walletAddressDirectionToggle, walletSearchAddressInput, true);
    
    // NEW: Last 4 search (Desktop)
    if (searchLast4Input) {
        searchLast4Input.addEventListener('input', () => {
            if (desktopSearchMode === 'member') {
                handleMemberInput();
            } else {
                handleLast4Input();
            }
        });
    }
    if (last4LtrBtn) {
        last4LtrBtn.addEventListener('click', () => {
            last4SearchMode = 'ltr';
            desktopSearchMode = 'last4-ltr';
            last4LtrBtn.classList.add('bg-cyan-600', 'border-cyan-500');
            last4RtlBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
            daoMemberBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
            if (searchLast4Input) { searchLast4Input.placeholder = 'As you read it'; searchLast4Input.value = ''; searchLast4Input.maxLength = 4; searchLast4Input.focus(); }
        });
    }
    if (last4RtlBtn) {
        last4RtlBtn.addEventListener('click', () => {
            last4SearchMode = 'rtl';
            desktopSearchMode = 'last4-rtl';
            last4RtlBtn.classList.add('bg-cyan-600', 'border-cyan-500');
            last4LtrBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
            daoMemberBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
            if (searchLast4Input) { searchLast4Input.placeholder = 'Last char first'; searchLast4Input.value = ''; searchLast4Input.maxLength = 4; searchLast4Input.focus(); }
        });
    }
    // NEW: DAO Member button (Desktop)
    if (daoMemberBtn) {
        daoMemberBtn.addEventListener('click', () => {
            desktopSearchMode = 'member';
            daoMemberBtn.classList.add('bg-cyan-600', 'border-cyan-500');
            last4LtrBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
            last4RtlBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
            if (searchLast4Input) { 
                searchLast4Input.placeholder = 'Type member name'; 
                searchLast4Input.value = ''; 
                searchLast4Input.maxLength = 50; 
                searchLast4Input.focus(); 
            }
        });
    }
    if (copyLast4Btn) copyLast4Btn.addEventListener('click', () => copyWithVerification(searchAddressInput?.value));
    if (copyAddressBtn) copyAddressBtn.addEventListener('click', (e) => { e.preventDefault(); copyWithVerification(searchAddressInput?.value); });
    if (copyVerifyBtn) copyVerifyBtn.addEventListener('click', () => copyVerifyModal?.classList.add('hidden'));
    if (copyVerifyModal) copyVerifyModal.addEventListener('click', (e) => { if (e.target === copyVerifyModal) copyVerifyModal.classList.add('hidden'); });
    
    // NEW: Paste buttons
    if (pasteAddressBtn) pasteAddressBtn.addEventListener('click', () => pasteFromClipboard(searchAddressInput, handleFilterChange));
    if (mobilePasteBtn) mobilePasteBtn.addEventListener('click', () => pasteFromClipboard(mobileSearchAddress, () => { if (searchAddressInput) searchAddressInput.value = mobileSearchAddress.value; handleFilterChange(); }));
    
    // NEW: Mobile search (Collection page)
    if (mobileAsReadBtn) mobileAsReadBtn.addEventListener('click', () => { mobileSearchMode = 'full'; updateMobileSearchUI(); });
    if (mobileLast4LtrBtn) mobileLast4LtrBtn.addEventListener('click', () => { mobileSearchMode = 'last4-ltr'; updateMobileSearchUI(); });
    if (mobileLast4RtlBtn) mobileLast4RtlBtn.addEventListener('click', () => { mobileSearchMode = 'last4-rtl'; updateMobileSearchUI(); });
    // NEW: Mobile DAO Member button
    if (mobileDaoMemberBtn) mobileDaoMemberBtn.addEventListener('click', () => { mobileSearchMode = 'member'; updateMobileSearchUI(); });
    if (mobileSearchAddress) mobileSearchAddress.addEventListener('input', handleMobileAddressInput);
    if (mobileCopyBtn) mobileCopyBtn.addEventListener('click', () => copyWithVerification(mobileSearchAddress?.value || searchAddressInput?.value));
    if (mobileAddressDropdown) mobileAddressDropdown.addEventListener('change', () => {
        if (mobileSearchAddress) mobileSearchAddress.value = mobileAddressDropdown.value;
        if (searchAddressInput) searchAddressInput.value = mobileAddressDropdown.value;
        handleFilterChange();
    });
    
    // NEW: Wallet page search (Desktop)
    if (walletPasteBtn) walletPasteBtn.addEventListener('click', () => pasteFromClipboard(walletSearchAddressInput, searchWallet));
    if (walletSearchLast4) walletSearchLast4.addEventListener('input', () => handleWalletLast4Input());
    if (walletLast4LtrBtn) walletLast4LtrBtn.addEventListener('click', () => {
        walletLast4SearchMode = 'ltr';
        walletLast4LtrBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        walletLast4RtlBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
        if (walletSearchLast4) { walletSearchLast4.placeholder = 'As you read it'; walletSearchLast4.value = ''; walletSearchLast4.focus(); }
    });
    if (walletLast4RtlBtn) walletLast4RtlBtn.addEventListener('click', () => {
        walletLast4SearchMode = 'rtl';
        walletLast4RtlBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        walletLast4LtrBtn?.classList.remove('bg-cyan-600', 'border-cyan-500');
        if (walletSearchLast4) { walletSearchLast4.placeholder = 'Last char first'; walletSearchLast4.value = ''; walletSearchLast4.focus(); }
    });
    if (walletCopyLast4Btn) walletCopyLast4Btn.addEventListener('click', () => copyWithVerification(walletSearchAddressInput?.value));
    
    // NEW: Wallet page search (Mobile)
    if (walletMobilePasteBtn) walletMobilePasteBtn.addEventListener('click', () => pasteFromClipboard(walletMobileSearchAddress, () => { if (walletSearchAddressInput) walletSearchAddressInput.value = walletMobileSearchAddress.value; searchWallet(); }));
    if (walletMobileAsReadBtn) walletMobileAsReadBtn.addEventListener('click', () => { walletMobileSearchMode = 'full'; updateWalletMobileSearchUI(); });
    if (walletMobileLast4LtrBtn) walletMobileLast4LtrBtn.addEventListener('click', () => { walletMobileSearchMode = 'last4-ltr'; updateWalletMobileSearchUI(); });
    if (walletMobileLast4RtlBtn) walletMobileLast4RtlBtn.addEventListener('click', () => { walletMobileSearchMode = 'last4-rtl'; updateWalletMobileSearchUI(); });
    if (walletMobileSearchAddress) walletMobileSearchAddress.addEventListener('input', handleWalletMobileAddressInput);
    if (walletMobileCopyBtn) walletMobileCopyBtn.addEventListener('click', () => copyWithVerification(walletMobileSearchAddress?.value || walletSearchAddressInput?.value));
    if (walletResetBtnMobile) walletResetBtnMobile.addEventListener('click', () => walletResetBtn?.click());
    
    // Map listeners
    addMapListeners(); // Add map listeners
    window.addEventListener('resize', handleMapResize); // Add resize listener
    window.addEventListener('hashchange', handleHashChange); // Add hashchange listener
};

function switchView(viewName, fromHistory = false) {
    // Deep-linkable tabs: ?view=analytics|wallet (collection = clean URL). pushState lets
    // Vercel Web Analytics count tab switches as navigations; popstate restores on back/forward.
    if (!fromHistory) {
        try {
            const p = new URLSearchParams(window.location.search);
            if (viewName === 'collection') p.delete('view'); else p.set('view', viewName);
            const qs = p.toString();
            const newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
            if (newUrl !== window.location.pathname + window.location.search + window.location.hash) {
                history.pushState({ view: viewName }, '', newUrl);
            }
            if (typeof window.va === 'function') window.va('event', { name: 'explorer_tab', data: { tab: viewName } });
        } catch (e) { /* URL update is best-effort */ }
    }
    if (viewName !== 'map' && globalAnimationFrameId) {
        cancelAnimationFrame(globalAnimationFrameId);
        globalAnimationFrameId = null;
        // isMapInitialized = false; // Keep map initialized but stop animation
    }
    if (collectionView) collectionView.classList.add('hidden');
    if (walletView) walletView.classList.add('hidden');
    if (analyticsView) analyticsView.classList.add('hidden');
    if (mapView) mapView.classList.add('hidden');
    if (collectionViewBtn) collectionViewBtn.classList.remove('active');
    if (walletViewBtn) walletViewBtn.classList.remove('active');
    if (analyticsViewBtn) analyticsViewBtn.classList.remove('active');
    if (mapViewBtn) mapViewBtn.classList.remove('active');

    if (viewName === 'collection') {
        if (collectionView) collectionView.classList.remove('hidden');
        if (collectionViewBtn) collectionViewBtn.classList.add('active');
    } else if (viewName === 'analytics') {
        if (analyticsView) analyticsView.classList.remove('hidden');
        if (analyticsViewBtn) analyticsViewBtn.classList.add('active');
        renderAnalytics(); // lazy — builds once
    } else if (viewName === 'wallet') {
        if (walletView) walletView.classList.remove('hidden');
        if (walletViewBtn) walletViewBtn.classList.add('active');
    } else if (viewName === 'map') {
        if (mapView) mapView.classList.remove('hidden');
        if (mapViewBtn) mapViewBtn.classList.add('active');
        requestAnimationFrame(initializeStarfield); // Use requestAnimationFrame
    }
}

// ============================================================================
// ANALYTICS VIEW — collection-wide trading analytics (new pipeline only)
//   data/v2/nft-analytics.json   (aggregates: volume, leaderboards, monthly, flips)
//   data/v2/summary.json         (backing + marketplace listing state)
//   data/v2/sales-enriched.json  (per-sale, for highest/biggest sales)
// ============================================================================
const ANALYTICS_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/nft-analytics.json";
const ANALYTICS_SUMMARY_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/summary.json";
const ANALYTICS_ENRICHED_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/sales-enriched.json";
const BROKEN_AT_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/broken-at.json";
const LISTING_HISTORY_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/listing-first-seen.json";
const LUNA_ORACLE_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/luna-usd-daily.json";
const BLUNA_ORACLE_URL = "https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/bluna-usd-daily.json";
const DENOM_BLUNA = "cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml";
const DENOM_SOLID = "cw20:terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst";

let analyticsLoaded = false;
let _avMonths = [];          // monthly data, for chart scale toggle
let _avScale = "log";        // default log so recent months are visible
let _fpData = null;          // floor-history slots {monthly:{labels,tiers},weekly:{...}}
let _fpTier = "base";        // broken | base | phoenix
let _fpGran = "monthly";     // monthly (12M) | weekly (12W)
let _fpListingFloor = {};    // current listing floor per tier (dashed reference line)
let _fpBrokenAt = null;      // token_id -> broken_at ISO (exact sale-time tiers)
let _fpBand = null;          // historical listing-floor per period: {mid, lo, hi} per slot
let _fpLuna = null;          // daily LUNA USD map for the price overlay
let _fpShowLuna = true;      // LUNA overlay toggle
let _avX = {};               // live numbers stashed for the metric-explainer modal

// --- Metric explainers: click any big-ticket number for the full methodology ---
function showMetricExplainer(key) {
    const d = _avX || {};
    const F = fmtUsdFull, f = fmtUsd, N = fmtNum;
    const C = {
        market_cap: ["Market cap — how we compute it", `
          <p>Collections are usually quoted as <em>floor × supply</em> — one price for every NFT. That overstates a collection like this one, where three very different assets share the supply: <b>Broken</b> (no backing claim), <b>Unbroken base</b>, and <b>Phoenix</b> (the 40-grade apex trait).</p>
          <p>So we price each tier separately with its <b>mark price</b> (see Mark) and sum:</p>
          <p class="font-mono text-xs bg-gray-900/70 rounded p-2">Market cap = Σ (tier mark × tier circulating supply)<br>
          Broken: ${f(d.tierMark?.broken)} × ${N(d.tierCounts?.circ.broken)} &nbsp;·&nbsp; Base: ${f(d.tierMark?.base)} × ${N(d.tierCounts?.circ.base)} &nbsp;·&nbsp; Phoenix: ${f(d.tierMark?.phoenix)} × ${N(d.tierCounts?.circ.phoenix)}<br>= <b>${F(d.marketCap)}</b></p>
          <p><b>Circulating</b> = minted NFTs only (${N((d.tierCounts?.circ.broken||0)+(d.tierCounts?.circ.base||0)+(d.tierCounts?.circ.phoenix||0))}). The <b>FDV</b> subline applies the same marks to all 10,000 incl. the unminted reserve: ${F(d.fdv)}.</p>
          <p class="text-gray-500">Caveat: marks come from a thin market — a handful of sales and asks move them. This is an estimate, not a quote.</p>`],
        mark: ["Mark price — how we compute it", `
          <p>Two honest prices exist for an NFT tier and they usually disagree: the <b>sales floor</b> (median of recent actual sales, USD at sale time) and the <b>listing floor</b> (cheapest current ask). The last trade can be stale; the ask can be wishful.</p>
          <p>The mark takes the midpoint, like a market-maker quoting mid between bid history and ask:</p>
          <p class="font-mono text-xs bg-gray-900/70 rounded p-2">mark = (sales floor + listing floor) / 2<br>
          Base: (${f(d.tierStats?.base.sf)} + ${f(d.tierStats?.base.lf)}) / 2 = <b>${f(d.tierMark?.base)}</b><br>
          Broken: <b>${f(d.tierMark?.broken)}</b> · Phoenix: <b>${f(d.tierMark?.phoenix)}</b></p>
          <p>If one side is missing (e.g. no live ask in a tier), the mark falls back to the side that exists. Tier membership for sales uses on-chain <b>break timestamps</b>, so a sale counts in the tier the NFT was in when it sold.</p>`],
        backing_nft: ["Backing per NFT — how it works", `
          <p>Every <b>unbroken</b> NFT is a claim on the DAO's ampLUNA vault. Breaking an NFT forfeits that claim forever (the NFT keeps its art and voting power) — which is why backing concentrates into fewer NFTs as others break:</p>
          <p class="font-mono text-xs bg-gray-900/70 rounded p-2">backing/NFT = vault ampLUNA ÷ unbroken count<br>= ${N(d.bk?.ampluna_balance)} ÷ ${N(d.bk?.unbroken_count)} = <b>${(+d.bk?.per_nft_ampluna||0).toFixed(2)} ampLUNA</b> (${f(d.bk?.per_nft_value_usd)})</p>
          <p>The ampLUNA amount is the durable number; its USD value moves with LUNA. ampLUNA itself is Eris liquid-staked LUNA and appreciates vs LUNA via the staking exchange rate (currently ~${(+d.bk?.ratio||0) ? (+d.bk.ratio).toFixed(3) : "2.1+"}× LUNA).</p>`],
        total_backing: ["Total backing — how we compute it", `
          <p>The DAO vault's ampLUNA balance, read live from chain, valued at the live ampLUNA price (LUNA spot × Eris exchange rate):</p>
          <p class="font-mono text-xs bg-gray-900/70 rounded p-2">${N(d.bk?.ampluna_balance)} ampLUNA × price = <b>${F(d.bk?.treasury_value_usd)}</b></p>
          <p>This pool backs only the ${N(d.bk?.unbroken_count)} unbroken NFTs — broken NFTs forfeited their share permanently, which raised everyone else's.</p>`],
        volume: ["All-time volume — USD at time of sale", `
          <p>Every sale is swept from chain history across BBL, Atrium and Boost (${N(d.vol?.sales_count)} sales). The hard part is the dollar value: a 1,000-LUNA sale in Jan-2024 and one today are very different dollars.</p>
          <p>So each sale is valued at <b>the token's USD price on the day it happened</b>, using daily price series (LUNA and bLUNA; bLUNA before its series begins is derived from LUNA × the historical bLUNA/LUNA ratio curve; SOLID is the $1 stablecoin):</p>
          <p class="font-mono text-xs bg-gray-900/70 rounded p-2">sale USD = token amount × token's USD price on sale date<br>Σ all sales = <b>${F(d.vol?.usd_at_sale)}</b></p>
          <p>That's why this number can't be reproduced by multiplying today's prices — it's a true historical record, not a revaluation.</p>`],
        nakamoto: ["Nakamoto coefficient — what it means", `
          <p>The minimum number of independent wallets that together control <b>more than 50%</b> of governance power. Named after the analogous measure for blockchain validators. Lower = more concentrated = fewer actors could decide any vote.</p>
          <p>Here, governance power = DAODAO-staked NFTs (1 staked NFT = 1 vote; broken NFTs keep their vote). Sorting the ${N(d.stakerCount)} stakers by voting power and summing from the top:</p>
          <p class="font-mono text-xs bg-gray-900/70 rounded p-2">top ${d.nakamoto} wallets &gt; 50% of staked VP → <b>Nakamoto = ${d.nakamoto}</b><br>top 1: ${(d.top1||0).toFixed(1)}% · top 5: ${(d.top5||0).toFixed(1)}% · top 10: ${(d.top10||0).toFixed(1)}%</p>
          <p>Reading the scale: 1–3 highly concentrated, 4–7 concentrated, 8–15 moderately distributed, 16+ distributed. For context, major proof-of-stake chains often sit in the 2–7 range — small DAOs rarely score high, but knowing the number honestly is what matters for voters deciding whether their vote counts.</p>`],
        supply: ["Supply — reading the collection like a token", `
          <p><b>Max supply</b> 10,000 is fixed at mint. <b>Circulating</b> counts minted NFTs only — the ${N(d.sup?.unminted)} unminted sit in the DAO's reserve wallet like untapped max supply.</p>
          <p>Within circulating: <b>staked</b> (DAODAO + Enterprise — locked but user-owned), <b>pending claim</b> (in the unstake window), <b>DAO broken</b> (treasury-held governance NFTs), and <b>free float</b> — the only part that can actually trade, of which a slice is listed right now.</p>
          <p>Float ÷ circulating is the liquidity reality check: a small float means thin books and jumpy floors.</p>`]
    };
    const item = C[key]; if (!item) return;
    let m = document.getElementById("av-explain-modal");
    if (!m) {
        m = document.createElement("div");
        m.id = "av-explain-modal";
        m.style.cssText = "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);padding:1rem";
        m.addEventListener("click", (e) => { if (e.target === m) m.style.display = "none"; });
        document.body.appendChild(m);
    }
    m.innerHTML = `<div class="bg-gray-800 border border-gray-600 rounded-xl max-w-lg w-full p-5 text-sm text-gray-300 space-y-3" style="max-height:85vh;overflow-y:auto">
      <div class="flex items-start justify-between"><h3 class="text-cyan-400 font-bold text-base pr-4">${item[0]}</h3>
      <button class="text-gray-400 hover:text-white text-xl leading-none" onclick="document.getElementById('av-explain-modal').style.display='none'">&times;</button></div>${item[1]}</div>`;
    m.style.display = "flex";
}
let _fpOffset = 0;           // paging: 0 = latest 12 periods, 1 = the 12 before, ...

// ---- formatters ----
const fmtUsd = (n) => {
    if (n == null || isNaN(n)) return "—";
    const neg = n < 0 ? "-" : ""; const a = Math.abs(n);
    if (a >= 1e6) return `${neg}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${neg}$${(a / 1e3).toFixed(1)}K`;
    return `${neg}$${a.toFixed(a < 10 ? 2 : 0)}`;
};
const fmtUsdFull = (n) => (n == null || isNaN(n)) ? "—" : `$${Math.round(n).toLocaleString()}`;
const fmtNum = (n) => (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString();
const aShort = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
const aLabel = (a) => {
    const sys = (typeof getSystemWalletLabel === "function") ? getSystemWalletLabel(a) : null;
    if (sys) return sys;
    const m = (typeof getMemberName === "function") ? getMemberName(a) : null;
    return m ? m : aShort(a);
};

// ---- SVG bar chart with linear/log scale + native tooltips ----
function svgBars(values, { h = 170, accent = "#22d3ee", fmt = fmtUsd, scale = "linear" } = {}) {
    if (!values.length) return "";
    const raw = values.map(v => Math.max(0, v.value));
    const tf = (x) => scale === "log" ? Math.log10(x + 1) : x;
    const max = Math.max(...raw.map(tf), 0.0001);
    const n = values.length, gap = 1.5, bw = Math.max(1.5, (100 - gap * n) / n);
    let bars = "", x = 0;
    values.forEach((v) => {
        const bh = (tf(Math.max(0, v.value)) / max) * 88;
        bars += `<rect x="${x.toFixed(2)}" y="${(92 - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(0, bh).toFixed(2)}" rx="0.5" fill="url(#agrad)" opacity="0.92"><title>${v.label}: ${fmt(v.value)}${v.sub ? ` · ${v.sub}` : ""}</title></rect>`;
        x += bw + gap;
    });
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:${h}px;display:block">
      <defs><linearGradient id="agrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/><stop offset="100%" stop-color="${accent}" stop-opacity="0.25"/>
      </linearGradient></defs>${bars}</svg>`;
}
function hBar(value, max, accent = "#22d3ee") {
    const pct = max ? Math.min(100, (value / max) * 100) : 0;
    return `<div style="background:rgba(255,255,255,.06);border-radius:4px;height:8px;overflow:hidden"><div style="width:${pct.toFixed(1)}%;height:100%;background:${accent};border-radius:4px"></div></div>`;
}
// re-render just the volume chart when the scale toggle is clicked
function renderVolChart() {
    const el = document.getElementById("av-vol-chart");
    if (!el) return;
    el.innerHTML = svgBars(_avMonths.map(m => ({ label: m.month, value: m.notional_usd, sub: `${m.count} sales` })), { h: 180, scale: _avScale });
    const lin = document.getElementById("av-scale-lin"), log = document.getElementById("av-scale-log");
    if (lin && log) {
        lin.className = `av-scale-btn ${_avScale === "linear" ? "active" : ""}`;
        log.className = `av-scale-btn ${_avScale === "log" ? "active" : ""}`;
    }
}

// Floor-history chart (sales-derived): floating low-high bar per period, dash at median.
function renderFpChart() {
    const el = document.getElementById("av-fp-chart");
    if (!el || !_fpData) return;
    const d = _fpData[_fpGran];
    const total = d.keys.length;
    const end = Math.max(12, total - _fpOffset * 12);
    const start = Math.max(0, end - 12);
    const slots = d.tiers[_fpTier].slice(start, end); const labels = d.labels.slice(start, end);
    const bandAll = (_fpBand && _fpBand[_fpGran]) ? _fpBand[_fpGran].floors[_fpTier] : null;
    const band = bandAll ? bandAll.slice(start, end) : null;
    const lfRef = _fpOffset === 0 ? (_fpListingFloor[_fpTier] ?? null) : null; // today's floor only on the live window
    const highs = slots.filter(Boolean).map(s => s.high);
    if (band) band.forEach(v => { if (v != null) highs.push(v.hi); });
    if (lfRef != null) highs.push(lfRef);
    const max = highs.length ? Math.max(...highs) * 1.08 : 1;
    const edgeLabels = []; // right-edge annotations, de-collided before drawing
    const W = 600, H = 210, padL = 44, padB = 22, padT = 8;
    const x = (i) => padL + i * ((W - padL - 8) / labels.length) + 4;
    const bw = ((W - padL - 8) / labels.length) - 8;
    const y = (v) => padT + (1 - v / max) * (H - padT - padB);
    let g = "";
    // gridlines: 0, mid, max
    [[0, "0"], [max / 2, fmtUsd(max / 2)], [max / 1.08, fmtUsd(max / 1.08)]].forEach(([v, l]) => {
        g += `<line x1="${padL}" y1="${y(v)}" x2="${W - 4}" y2="${y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="#6b7280">${l}</text>`;
    });
    labels.forEach((lab, i) => {
        const s = slots[i];
        const lx = x(i) + bw / 2;
        g += `<text x="${lx}" y="${H - 6}" text-anchor="middle" font-size="8.5" fill="${s ? "#9ca3af" : "#4b5563"}">${lab}</text>`;
        if (!s) { g += `<line x1="${x(i) + 2}" y1="${y(0) - 1}" x2="${x(i) + bw - 2}" y2="${y(0) - 1}" stroke="#374151" stroke-width="2"/>`; return; }
        const yH = y(s.high), yL = y(s.low), yM = y(s.med);
        g += `<g><title>${lab} · ${s.n} sale${s.n === 1 ? "" : "s"} · low ${fmtUsd(s.low)} · median ${fmtUsd(s.med)} · high ${fmtUsd(s.high)}</title>
          <rect x="${x(i)}" y="${yH}" width="${bw}" height="${Math.max(2, yL - yH)}" rx="2" fill="rgba(34,211,238,.28)" stroke="rgba(34,211,238,.5)" stroke-width="0.5"/>
          <line x1="${x(i)}" y1="${yM}" x2="${x(i) + bw}" y2="${yM}" stroke="#fbbf24" stroke-width="2"/></g>`;
    });
    if (band) {
        // historical listing floor: translucent range area (USD swing of the standing floor while
        // the token amount stayed fixed) + dashed mid step-line
        band.forEach((v, i) => {
            if (v == null) return;
            const yH = y(v.hi), yL = y(v.lo);
            g += `<rect x="${x(i)}" y="${yH}" width="${bw}" height="${Math.max(1.5, yL - yH)}" fill="rgba(34,211,238,.13)" stroke="rgba(34,211,238,.25)" stroke-width="0.4" rx="1"><title>${labels[i]}: cheapest listing ${fmtUsd(v.mid)} mid · ${fmtUsd(v.lo)}–${fmtUsd(v.hi)} USD range while listed (token price moved, ask didn't)</title></rect>`;
        });
        let path = "", lastY = null;
        band.forEach((v, i) => {
            if (v == null) { lastY = null; return; }
            const yx = y(v.mid), x0 = x(i), x1 = x(i) + bw;
            path += (lastY == null ? `M ${x0} ${yx}` : ` L ${x0} ${lastY} L ${x0} ${yx}`) + ` L ${x1} ${yx}`;
            lastY = yx;
        });
        if (path) g += `<path d="${path}" fill="none" stroke="#22d3ee" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.9"/>`;
    }
    // LUNA price overlay (own scale, right axis) — read floor moves against the token's USD move
    let lunaLabel = "";
    if (_fpShowLuna && _fpLuna) {
        const keysWin = d.keys.slice(start, end);
        const lpKeys = Object.keys(_fpLuna).sort();
        const near = (ds) => { let b = null; for (const k of lpKeys) { if (k <= ds) b = k; else break; } return b ? _fpLuna[b] : null; };
        const pts = keysWin.map(k => near(_fpGran === "monthly" ? k + "-15" : k));
        const vals = pts.filter(v => v != null);
        if (vals.length) {
            const lmax = Math.max(...vals) * 1.05;
            let lp = "";
            pts.forEach((v, i) => { if (v == null) return; const px = x(i) + bw / 2, py = padT + (1 - v / lmax) * (H - padT - padB); lp += (lp ? " L" : "M") + ` ${px} ${py}`; });
            g += `<path d="${lp}" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.7"><title>LUNA price (own scale, right)</title></path>`;
            const lastV = [...pts].reverse().find(v => v != null);
            if (lastV != null) edgeLabels.push({ y: padT + (1 - lastV / lmax) * (H - padT - padB) + 3, text: `LUNA $${lastV < 1 ? lastV.toFixed(3) : lastV.toFixed(2)}`, fill: "#a78bfa" });
        }
    }

    // Right-edge annotations: collected above, pushed apart vertically before drawing
    if (lfRef != null) {
        g += `<g><title>Today's listing floor: ${fmtUsd(lfRef)}</title><line x1="${padL}" y1="${y(lfRef)}" x2="${W - 4}" y2="${y(lfRef)}" stroke="#34d399" stroke-width="1.2" stroke-dasharray="5,4"/></g>`;
        edgeLabels.push({ y: y(lfRef) - 4, text: `listing floor ${fmtUsd(lfRef)}`, fill: "#34d399" });
    }
    // de-collide: sort by y, enforce >=11px spacing, clamp inside plot
    edgeLabels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < edgeLabels.length; i++) if (edgeLabels[i].y - edgeLabels[i - 1].y < 11) edgeLabels[i].y = edgeLabels[i - 1].y + 11;
    for (let i = edgeLabels.length - 2; i >= 0; i--) if (edgeLabels[i + 1].y - edgeLabels[i].y < 11) edgeLabels[i].y = edgeLabels[i + 1].y - 11;
    edgeLabels.forEach(l => { l.y = Math.max(padT + 8, Math.min(H - padB - 2, l.y)); g += `<text x="${W - 6}" y="${l.y}" text-anchor="end" font-size="9" fill="${l.fill}" style="paint-order:stroke" stroke="rgba(13,17,23,.85)" stroke-width="3">${l.text}</text>`; });
    const tierNote = _fpBrokenAt
        ? `<span class="text-gray-600">Tiers exact via on-chain break timestamps.</span>`
        : `<span class="text-amber-400/90">&#9888; Tiers approximate (current broken state) — break-timestamp feed unavailable.</span>`;
    const winLabel = `${labels[0]} → ${labels[labels.length - 1]}`;
    const canBack = start > 0, canFwd = _fpOffset > 0;
    el.innerHTML = `<div class="flex items-center justify-between mb-1 text-[11px]">
        <div class="flex items-center gap-1">
          <button id="av-fp-back" class="av-scale-btn" ${canBack ? "" : "disabled style='opacity:.3'"}>&lsaquo; older</button>
          <button id="av-fp-fwd" class="av-scale-btn" ${canFwd ? "" : "disabled style='opacity:.3'"}>newer &rsaquo;</button>
          <span class="text-gray-500 ml-1">${winLabel}</span>
        </div>${tierNote}</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${g}</svg>`;
    const bk = document.getElementById("av-fp-back"), fw = document.getElementById("av-fp-fwd");
    if (bk && canBack) bk.onclick = () => { _fpOffset++; renderFpChart(); };
    if (fw && canFwd) fw.onclick = () => { _fpOffset--; renderFpChart(); };
    document.querySelectorAll(".av-fp-tier").forEach(b => b.classList.toggle("active", b.dataset.tier === _fpTier));
    document.querySelectorAll(".av-fp-gran").forEach(b => b.classList.toggle("active", b.dataset.gran === _fpGran));
}
function periodKey(date, gran) {
    if (gran === "monthly") return date.toISOString().slice(0, 7);
    const d = new Date(date); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); // Monday
    return d.toISOString().slice(0, 10);
}
// Full period axis from first sale (Dec 2023) to now, so the chart can page back through all history.
function fullPeriodKeys(gran) {
    const keys = []; const now = new Date(); const start = new Date(Date.UTC(2023, 11, 1));
    const d = new Date(start);
    while (d <= now) {
        keys.push(periodKey(d, gran));
        if (gran === "monthly") d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCDate(d.getUTCDate() + 7);
    }
    return [...new Set(keys)];
}
function buildFpData(salesDesc, tierOfSale) {
    const out = {};
    for (const gran of ["monthly", "weekly"]) {
        const keys = fullPeriodKeys(gran);
        const labels = keys.map(k => gran === "monthly" ? k.slice(2) : k.slice(5));
        const buckets = { broken: {}, base: {}, phoenix: {} };
        salesDesc.forEach(s => {
            if (s.notional_usd == null || !s.timestamp) return;
            const t = tierOfSale(s.token_id, s.timestamp); if (!t) return;
            const k = periodKey(new Date(s.timestamp), gran);
            (buckets[t][k] = buckets[t][k] || []).push(s.notional_usd);
        });
        const tiers = { broken: keys.map(() => null), base: keys.map(() => null), phoenix: keys.map(() => null) };
        for (const t of ["broken", "base", "phoenix"]) keys.forEach((k, i) => {
            const v = (buckets[t][k] || []).sort((a, b) => a - b);
            if (!v.length) return;
            const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
            tiers[t][i] = { n: v.length, low: v[0], med, high: v[v.length - 1] };
        });
        out[gran] = { keys, labels, tiers };
    }
    return out;
}
// Historical listing floor per period per tier, from the backfilled listing lifecycle.
// Each active segment overlapping a period is valued at the period-midpoint token price (daily oracles;
// SOLID treated as $1 stablecoin; segments with unknown denom skipped). Tier uses break timestamps.
function buildListingFloorBand(listingRecords, lunaOracle, blunaOracle) {
    const lp = lunaOracle.prices || lunaOracle.daily || lunaOracle.data || {};
    const bp = blunaOracle.prices || blunaOracle.daily || blunaOracle.data || {};
    const lpKeys = Object.keys(lp).sort(), bpKeys = Object.keys(bp).sort();
    const nearest = (map, keys, dateStr) => {
        if (map[dateStr] != null) return map[dateStr];
        let best = null;
        for (const k of keys) { if (k <= dateStr) best = k; else break; }
        return best ? map[best] : (keys.length ? map[keys[0]] : null);
    };
    const priceUsd = (denom, amount, dateStr) => {
        const a = Number(amount) / 1e6;
        if (denom === "uluna") { const p = nearest(lp, lpKeys, dateStr); return p != null ? a * p : null; }
        if (denom === DENOM_BLUNA) { const p = nearest(bp, bpKeys, dateStr) ?? ((nearest(lp, lpKeys, dateStr) || 0) * 1.3); return p ? a * p : null; }
        if (denom === DENOM_SOLID) return a * 1.0;
        return null;
    };
    const byIdLocal = {}; if (typeof allNfts !== "undefined") allNfts.forEach(n => { byIdLocal[String(n.id)] = n; });
    // Liveness cross-check: an open-ended ("still_listed") segment is only credible if the token
    // currently has a live priced listing — guards against stale auctions in the backfill (e.g. ghost 14765).
    const liveListed = new Set(Object.values(byIdLocal).filter(n => n.listing && n.listing.price_usd != null).map(n => String(n.id)));
    const brokenAtTs = (tid) => { const e = _fpBrokenAt && _fpBrokenAt[String(tid)]; return e ? Date.parse(e.broken_at || e) : null; };
    const tierAt = (tid, ts) => {
        const n = byIdLocal[String(tid)]; if (!n) return null;
        const b = brokenAtTs(tid);
        if (b != null && ts >= b) return "broken";
        return n.rarityClass === 40 ? "phoenix" : "base";
    };
    const out = {};
    for (const gran of ["monthly", "weekly"]) {
        const keys = fullPeriodKeys(gran);
        const bounds = keys.map(k => {
            const s = gran === "monthly" ? Date.parse(k + "-01T00:00:00Z") : Date.parse(k + "T00:00:00Z");
            const e = gran === "monthly" ? (() => { const d = new Date(s); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); })() : s + 7 * 86400e3;
            return [s, e];
        });
        const floors = { broken: keys.map(() => null), base: keys.map(() => null), phoenix: keys.map(() => null) };
        listingRecords.forEach(r => {
            (r.segments || []).forEach(seg => {
                if (!seg.denom || seg.price == null || !seg.from_ts) return;
                if (!seg.to_ts && !liveListed.has(String(r.token_id))) return; // stale open segment
                const s0 = Date.parse(seg.from_ts);
                const s1 = seg.to_ts ? Date.parse(seg.to_ts) : Date.now();
                bounds.forEach(([ps, pe], i) => {
                    if (s1 <= ps || s0 >= pe) return; // no overlap
                    const o0 = Math.max(s0, ps), o1 = Math.min(s1, pe);
                    const day = (t) => new Date(t).toISOString().slice(0, 10);
                    // USD value sampled at overlap start / mid / end: same token amount, moving token price
                    const samples = [priceUsd(seg.denom, seg.price, day(o0)), priceUsd(seg.denom, seg.price, day((o0 + o1) / 2)), priceUsd(seg.denom, seg.price, day(o1 - 1))].filter(v => v != null);
                    if (!samples.length) return;
                    const t = tierAt(r.token_id, (o0 + o1) / 2);
                    if (!t) return;
                    const mid = samples[Math.floor(samples.length / 2)] ?? samples[0];
                    const cur = floors[t][i];
                    if (cur == null || mid < cur.mid) floors[t][i] = { mid, lo: Math.min(...samples), hi: Math.max(...samples) };
                });
            });
        });
        out[gran] = { keys, floors };
    }
    return out;
}

// current-holdings map (who holds what NOW) for buyer/seller behaviour context
function buildHoldingsMap() {
    const m = {};
    if (typeof allNfts === "undefined" || !Array.isArray(allNfts)) return m;
    allNfts.forEach(n => {
        if (!n.owner) return;
        const h = m[n.owner] || (m[n.owner] = { held: 0, staked: 0, liquid: 0, listed: 0 });
        h.held++;
        if (n.staked_daodao || n.staked_enterprise_legacy) h.staked++;
        if (n.liquid) h.liquid++;
        if (n.bbl_market || n.atrium_market || n.boost_market) h.listed++;
    });
    return m;
}
function holdingsBlurb(h) {
    if (!h || h.held === 0) return `<span class="text-gray-500">now holds 0 · exited</span>`;
    const bits = [`${h.held} held`];
    if (h.staked) bits.push(`${h.staked} staked`);
    if (h.listed) bits.push(`${h.listed} listed`);
    let tag = "holding", tc = "text-gray-400";
    if (h.staked >= h.held * 0.6) { tag = "accumulating"; tc = "text-cyan-400"; }
    else if (h.listed > 0) { tag = "selling"; tc = "text-amber-400"; }
    return `<span class="text-gray-500">now: ${bits.join(" · ")}</span> <span class="${tc}">· ${tag}</span>`;
}

async function renderAnalytics() {
    const root = document.getElementById("analytics-view");
    if (!root || analyticsLoaded) return;
    root.innerHTML = `<div class="text-center text-gray-400 py-16"><i class="fas fa-circle-notch fa-spin text-cyan-400 text-2xl"></i><p class="mt-3 text-sm">Loading collection analytics…</p></div>`;

    let A, S, E = null;
    try {
        const [ar, sr, er, br, lr, our, obr] = await Promise.all([
            fetch(ANALYTICS_URL), fetch(ANALYTICS_SUMMARY_URL), fetch(ANALYTICS_ENRICHED_URL),
            fetch(BROKEN_AT_URL).catch(() => null), fetch(LISTING_HISTORY_URL).catch(() => null),
            fetch(LUNA_ORACLE_URL).catch(() => null), fetch(BLUNA_ORACLE_URL).catch(() => null)
        ]);
        if (!ar.ok) throw new Error(`analytics feed ${ar.status}`);
        A = await ar.json();
        if (!A || !A.volume || !A.leaderboards) throw new Error("analytics feed malformed");
        S = sr.ok ? await sr.json() : null;     // backing/listings — enhancement
        E = er.ok ? await er.json() : null;     // per-sale — enhancement
        // Exact sale-time tier classification (NFTs can't unbreak, so this is deterministic)
        try { const bj = (br && br.ok) ? await br.json() : null; _fpBrokenAt = bj && bj.entries ? bj.entries : null; } catch (e) { _fpBrokenAt = null; }
        // Historical listing-floor band (backfilled listing lifecycle + daily oracles)
        try {
            const lj = (lr && lr.ok) ? await lr.json() : null;
            const lo = (our && our.ok) ? await our.json() : null;
            const bo = (obr && obr.ok) ? await obr.json() : null;
            _fpBand = (lj && lj.records && lo && bo) ? buildListingFloorBand(lj.records, lo, bo) : null;
            _fpLuna = lo ? (lo.prices || lo.daily || lo.data || null) : null;
        } catch (e) { _fpBand = null; }
    } catch (e) {
        root.innerHTML = `<div class="text-center py-16"><i class="fas fa-triangle-exclamation text-amber-400 text-2xl"></i>
          <p class="mt-3 text-gray-300">Analytics data is unavailable right now.</p>
          <p class="text-xs text-gray-500 mt-1">${e.message}. This panel shows live pipeline data only — try again shortly.</p></div>`;
        return;
    }

    analyticsLoaded = true;
    _avMonths = A.monthly || [];
    root.innerHTML = buildAnalyticsHtml(A, S, E);
    renderVolChart();
    renderFpChart();
    const lin = document.getElementById("av-scale-lin"), log = document.getElementById("av-scale-log");
    if (lin) lin.onclick = () => { _avScale = "linear"; renderVolChart(); };
    if (log) log.onclick = () => { _avScale = "log"; renderVolChart(); };
    root.querySelectorAll("[data-explain]").forEach(el => el.addEventListener("click", () => showMetricExplainer(el.dataset.explain)));
    document.querySelectorAll(".av-fp-tier").forEach(b => b.onclick = () => { _fpTier = b.dataset.tier; renderFpChart(); });
    document.querySelectorAll(".av-fp-gran").forEach(b => b.onclick = () => { _fpGran = b.dataset.gran; renderFpChart(); });
    const lunaBtn = document.getElementById("av-fp-luna");
    if (lunaBtn) lunaBtn.onclick = () => { _fpShowLuna = !_fpShowLuna; lunaBtn.classList.toggle("active", _fpShowLuna); renderFpChart(); };
}

function buildAnalyticsHtml(A, S, E) {
    const card = "bg-gray-800/50 border border-gray-700 rounded-xl p-4";
    const h = (t, sub) => `<div class="flex items-baseline justify-between mb-3"><h3 class="text-cyan-400 font-bold">${t}</h3>${sub ? `<span class="text-xs text-gray-500">${sub}</span>` : ""}</div>`;
    const vol = A.volume || {};

    // ----- highest sale (from enriched per-sale) -----
    let hi = null, biggest = [];
    if (E && Array.isArray(E.sales) && E.sales.length) {
        const sorted = [...E.sales].sort((a, b) => (b.notional_usd || 0) - (a.notional_usd || 0));
        hi = sorted[0];
        biggest = sorted.slice(0, 5);
    }
    const hiStat = hi ? `<div>
        <div class="text-xs uppercase tracking-wider text-gray-400">Highest sale</div>
        <div class="text-2xl font-bold text-amber-300 mt-1">${fmtUsdFull(hi.notional_usd)}</div>
        <div class="text-xs text-gray-500 mt-0.5">#${hi.token_id} · ${fmtNum(hi.amount)} ${hi.denom_symbol} · ${(hi.timestamp || "").slice(0, 10)}</div>
      </div>` : "";

    // ----- HERO -----
    let hero = ""; // assembled after mark/market-cap computation below

    // ----- VALUE TILES (royalties: now primary) -----
    const bk = (S && S.backing) || {}; const roy = A.royalties || {};
    let askUsd = 0, listed = 0;
    if (S && S.marketplaces) for (const mk of Object.values(S.marketplaces)) { listed += mk.count || 0; for (const t of Object.values(mk.by_token || {})) askUsd += t.total_usd || 0; }
    const tile = (label, big, sub, xkey) => `<div class="${card} ${xkey ? "cursor-pointer" : ""}" ${xkey ? `data-explain="${xkey}" title="Click: how this is computed"` : ""}><div class="text-xs uppercase tracking-wider text-gray-400">${label}${xkey ? ' <span class="text-gray-600">&#9432;</span>' : ""}</div><div class="text-2xl font-bold text-white mt-1">${big}</div><div class="text-xs text-gray-500 mt-0.5">${sub}</div></div>`;
    const tiles = `<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      ${tile("Backing / NFT", `${(+bk.per_nft_ampluna || 0).toFixed(2)} <span class='text-base text-cyan-300'>ampLUNA</span>`, `${fmtUsd(bk.per_nft_value_usd)} · ${fmtNum(bk.unbroken_count)} unbroken`, "backing_nft")}
      ${tile("Total backing", fmtUsdFull(bk.treasury_value_usd), `${fmtNum(bk.ampluna_balance)} ampLUNA in vault`, "total_backing")}
      ${tile("Royalties → DAO", fmtUsd(roy.to_dao_usd_today), `${fmtUsd(roy.to_dao_usd_when_earned)} if sold when received`)}
      ${tile("Listed now", fmtNum(listed), `${fmtUsd(askUsd)} ask-side liquidity`)}
    </div>`;

    // ----- INVESTOR PANELS: supply screener · floor by tier · governance concentration -----
    const nfts = (typeof allNfts !== "undefined" && Array.isArray(allNfts)) ? allNfts : [];
    const isPhoenix = (n) => n.rarityClass === 40; // grade 40 <-> Phoenix Rising, 1:1 by design
    const tierOf = (n) => n.broken ? "broken" : (isPhoenix(n) ? "phoenix" : "base");

    // --- Supply (the collection read like a token) ---
    const sup = { minted: 0, unminted: 0, staked: 0, pending: 0, daoBroken: 0, float: 0, listedN: 0 };
    nfts.forEach(n => {
        if (n.unminted) { sup.unminted++; return; }
        sup.minted++;
        if (n.staked_daodao || n.staked_enterprise_legacy) sup.staked++;
        else if (n.daodao_pending_claim) sup.pending++;
        else if (n.treasury_held || n.dao_wallet_8ywv_held || n.enterprise_dao_broken) sup.daoBroken++;
        else if (n.listing && n.listing.price_usd != null) sup.listedN++;
        else sup.float++;
    });
    const controlled = sup.staked + sup.pending + sup.daoBroken;
    const segBar = (segs) => {
        const tot = segs.reduce((s, x) => s + x.v, 0) || 1;
        return `<div class="flex h-3 rounded-full overflow-hidden">${segs.map(x => `<div style="width:${(x.v / tot * 100).toFixed(2)}%;background:${x.c}" title="${x.l}: ${fmtNum(x.v)}"></div>`).join("")}</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-400">${segs.map(x => `<span><span style="color:${x.c}">●</span> ${x.l} ${fmtNum(x.v)}</span>`).join("")}</div>`;
    };
    const srow = (l, v, sub) => `<div class="flex items-baseline justify-between py-1"><span class="text-sm text-gray-400">${l}</span><span class="text-sm font-semibold text-gray-100">${v}${sub ? ` <span class="text-xs text-gray-500 font-normal">${sub}</span>` : ""}</span></div>`;
    const supplyCard = `<div class="${card} cursor-pointer" data-explain="supply" title="Click: definitions">${h("Supply &#9432;", "the collection, read like a token")}
        ${srow("Max supply", fmtNum(nfts.length || 10000))}
        ${srow("Circulating (minted)", fmtNum(sup.minted), `${(sup.minted / (nfts.length || 10000) * 100).toFixed(1)}%`)}
        ${srow("Staked / DAO-controlled", fmtNum(controlled), `${(controlled / Math.max(sup.minted, 1) * 100).toFixed(1)}% of circulating`)}
        ${srow("Free float", fmtNum(sup.float + sup.listedN), `${fmtNum(sup.listedN)} of it listed`)}
        <div class="mt-3">${segBar([
            { l: "Staked", v: sup.staked, c: "#22d3ee" },
            { l: "Pending claim", v: sup.pending, c: "#67e8f9" },
            { l: "DAO broken", v: sup.daoBroken, c: "#f59e0b" },
            { l: "Float", v: sup.float, c: "#34d399" },
            { l: "Listed", v: sup.listedN, c: "#a78bfa" },
            { l: "Unminted", v: sup.unminted, c: "#374151" }
        ])}</div></div>`;

    // --- Governance concentration (DAODAO VP) ---
    let govCard = "";
    const stakers = (S && Array.isArray(S.daodao_stakers)) ? [...S.daodao_stakers].sort((a, b) => b.voting_power_pct - a.voting_power_pct) : [];
    if (stakers.length) {
        let cum = 0, nakamoto = 0;
        for (const x of stakers) { cum += x.voting_power_pct; nakamoto++; if (cum > 50) break; }
        const shareOf = (k) => stakers.slice(0, k).reduce((s, x) => s + x.voting_power_pct, 0);
        const top1 = shareOf(1), top5 = shareOf(5), top10 = shareOf(10);
        Object.assign(_avX, { nakamoto, top1, top5, top10, stakerCount: stakers.length });
        govCard = `<div class="${card}">${h("Governance concentration", "DAODAO-staked voting power")}
          <div class="flex items-end gap-6 mb-3">
            <div data-explain="nakamoto" class="cursor-pointer" title="Click: what this means"><div class="text-xs uppercase tracking-wider text-gray-400">Nakamoto coefficient <span class="text-gray-600">&#9432;</span></div>
              <div class="text-4xl font-extrabold text-white leading-none mt-1">${nakamoto} <span class="text-sm font-semibold ${nakamoto <= 3 ? "text-red-400" : nakamoto <= 7 ? "text-amber-400" : nakamoto <= 15 ? "text-lime-400" : "text-green-400"}">${nakamoto <= 3 ? "highly concentrated" : nakamoto <= 7 ? "concentrated" : nakamoto <= 15 ? "moderately distributed" : "distributed"}</span></div>
              <div class="text-[11px] text-gray-500 mt-1">wallets to reach &gt;50% of staked VP</div>
              <div class="mt-2" style="max-width:230px">
                <div class="relative flex h-2 rounded-full overflow-hidden">
                  <div style="width:15%;background:#f87171" title="1–3 highly concentrated"></div>
                  <div style="width:20%;background:#f59e0b" title="4–7 concentrated"></div>
                  <div style="width:40%;background:#a3e635" title="8–15 moderately distributed"></div>
                  <div style="width:25%;background:#34d399" title="16+ distributed"></div>
                  <div class="absolute top-0 h-2 w-0.5 bg-white" style="left:${Math.min(98, nakamoto / 20 * 100).toFixed(1)}%"></div>
                </div>
                <div class="flex justify-between text-[9px] text-gray-600 mt-0.5"><span>1</span><span>4</span><span>8</span><span>16</span><span>20+</span></div>
              </div></div>
            <div class="text-sm text-gray-400">${fmtNum(stakers.length)} stakers · ${fmtNum(sup.staked)} NFTs staked</div>
          </div>
          ${[["Top 1", top1], ["Top 5", top5], ["Top 10", top10]].map(([l, v]) => `<div class="flex items-center gap-3 py-1 text-sm"><span class="w-14 text-gray-400">${l}</span><div class="flex-1">${hBar(v, 100)}</div><span class="w-14 text-right text-gray-300">${v.toFixed(1)}%</span></div>`).join("")}
          <div class="text-[11px] text-gray-600 mt-2">1 staked NFT = 1 vote (broken NFTs keep their voting power)</div></div>`;
    }
    const supplyGovRow = `<div class="grid md:grid-cols-2 gap-3 mb-4">${supplyCard}${govCard}</div>`;

    // --- Floor by tier: listing floor vs sales-based floor ---
    const tierData = { broken: { listed: [] }, base: { listed: [] }, phoenix: { listed: [] } };
    nfts.forEach(n => { if (n.listing && n.listing.price_usd != null) tierData[tierOf(n)].listed.push(n.listing.price_usd); });
    Object.values(tierData).forEach(t => t.listed.sort((a, b) => a - b));
    const byIdT = {}; nfts.forEach(n => { byIdT[String(n.id)] = n; });
    const salesDesc = (E && Array.isArray(E.sales)) ? [...E.sales].sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")) : [];
    // Sale-time tier: exact via broken-at timestamps (NFTs can't unbreak); current-state fallback.
    const tierOfSale = (tid, ts) => {
        const n = byIdT[String(tid)]; if (!n) return null;
        if (_fpBrokenAt) {
            const e = _fpBrokenAt[String(tid)];
            const b = e ? Date.parse(e.broken_at || e) : null;
            if (b != null && Date.parse(ts) >= b) return "broken";
            return n.rarityClass === 40 ? "phoenix" : "base";
        }
        return tierOf(n);
    };
    const lastSales = (tier, k) => { const out = []; for (const x of salesDesc) { if (tierOfSale(x.token_id, x.timestamp) === tier) { out.push(x.notional_usd); if (out.length === k) break; } } return out; };
    const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    // Mark price per tier = midpoint of sales floor (what trades) and listing floor (the ask),
    // like a market-maker mid. Falls back to whichever side exists.
    const tierMark = {};
    const tierStats = {};
    [["broken", 5], ["base", 10], ["phoenix", 3]].forEach(([tier, k]) => {
        const t = tierData[tier]; const sf = median(lastSales(tier, k));
        const lf = t.listed.length ? t.listed[0] : null;
        tierMark[tier] = (sf && lf != null) ? (sf + lf) / 2 : (sf || lf || null);
        tierStats[tier] = { sf, lf };
    });
    const tierRow = (label, tier) => {
        const { sf, lf } = tierStats[tier]; const t = tierData[tier]; const mk = tierMark[tier];
        const spread = (lf != null && sf) ? ((lf - sf) / sf * 100) : null;
        return `<div class="grid grid-cols-6 gap-2 items-center py-2 border-t border-gray-700/50 text-sm">
          <span class="text-gray-200 font-medium">${label}</span>
          <span class="text-center text-gray-400">${t.listed.length}</span>
          <span class="text-center font-semibold ${lf != null ? "text-cyan-300" : "text-gray-600"}">${lf != null ? fmtUsd(lf) : "none"}</span>
          <span class="text-center font-semibold ${sf ? "text-amber-300" : "text-gray-600"}">${sf ? fmtUsd(sf) : "—"}</span>
          <span class="text-center font-semibold ${mk ? "text-gray-100" : "text-gray-600"}">${mk ? fmtUsd(mk) : "—"}</span>
          <span class="text-center ${spread == null ? "text-gray-600" : spread < -15 ? "text-green-400" : spread > 15 ? "text-red-400" : "text-gray-300"}">${spread == null ? "—" : (spread > 0 ? "+" : "") + spread.toFixed(0) + "%"}</span></div>`;
    };
    // Market cap = Σ tier mark × tier supply. Circulating uses minted only; FDV uses all 10,000.
    const tierCounts = { circ: { broken: 0, base: 0, phoenix: 0 }, all: { broken: 0, base: 0, phoenix: 0 } };
    nfts.forEach(n => { const t = tierOf(n); tierCounts.all[t]++; if (!n.unminted) tierCounts.circ[t]++; });
    const mcapOf = (counts) => ["broken", "base", "phoenix"].reduce((s, t) => s + (tierMark[t] || 0) * counts[t], 0);
    const marketCap = mcapOf(tierCounts.circ), fdv = mcapOf(tierCounts.all);
    _avX = { marketCap, fdv, tierMark, tierStats, tierCounts, bk, vol, sup };

    hero = `<div class="${card} mb-4" style="background:linear-gradient(135deg,rgba(34,211,238,.08),rgba(17,24,39,.4))">
        <div class="flex flex-wrap items-end gap-x-10 gap-y-3">
          <div data-explain="market_cap" class="cursor-pointer" title="Click: how this is computed"><div class="text-xs uppercase tracking-wider text-gray-400">Market cap <span class="text-gray-600">&#9432;</span></div>
            <div class="text-4xl font-extrabold text-white leading-none mt-1">${marketCap ? fmtUsdFull(marketCap) : "—"}</div>
            <div class="text-xs text-gray-500 mt-1">circulating (minted) · FDV ${fdv ? fmtUsdFull(fdv) : "—"} all 10,000</div></div>
          <div data-explain="mark" class="cursor-pointer" title="Click: how this is computed"><div class="text-xs uppercase tracking-wider text-gray-400">Mark price (base) <span class="text-gray-600">&#9432;</span></div>
            <div class="text-2xl font-bold text-gray-100 mt-1">${tierMark.base ? fmtUsd(tierMark.base) : "—"}</div>
            <div class="text-[11px] text-gray-500 mt-0.5">mid of sales floor &amp; ask</div></div>
          <div data-explain="volume" class="cursor-pointer" title="Click: how this is computed"><div class="text-xs uppercase tracking-wider text-gray-400">All-time volume <span class="text-gray-600">&#9432;</span></div>
            <div class="text-2xl font-bold text-cyan-300 mt-1">${fmtUsdFull(vol.usd_at_sale)}</div>
            <div class="text-[11px] text-gray-500 mt-0.5">${fmtNum(vol.sales_count)} sales · USD at sale</div></div>
          ${hiStat}
        </div></div>`;
    const bkUsd = (S && S.backing && S.backing.per_nft_value_usd) || null;
    const floorCard = `<div class="${card} mb-4">${h("Floor by tier", "listing floor vs what actually sells")}
      <div class="grid grid-cols-6 gap-2 text-[11px] uppercase tracking-wider text-gray-500 pb-1">
        <span>Tier</span><span class="text-center">Listed</span><span class="text-center">Listing floor</span><span class="text-center">Sales floor</span><span class="text-center">Mark</span><span class="text-center">Spread</span></div>
      ${tierRow("Broken", "broken")}
      ${tierRow("Unbroken (base)", "base")}
      ${tierRow("Phoenix", "phoenix")}
      <div class="text-[11px] text-gray-600 mt-3">Sales floor = median of recent sales in that tier (USD at sale, tiered by break timestamps). Mark = midpoint of sales floor and listing floor (market-maker mid) — market cap above = Σ tier mark × supply. Spread = listing floor vs sales floor — a deep negative spread means the cheapest listing sits far below real trading prices. Backing reference: ${bkUsd ? fmtUsd(bkUsd) : "—"}/NFT. Sales are classified by the NFT's current broken state.</div></div>`;

    // --- Floor history (sales-derived; listing-floor overlay arrives with listing backfill) ---
    _fpData = buildFpData(salesDesc, tierOfSale);
    _fpOffset = 0;
    _fpListingFloor = { broken: tierData.broken.listed[0] ?? null, base: tierData.base.listed[0] ?? null, phoenix: tierData.phoenix.listed[0] ?? null };
    const fpBtn = (cls, val, lab) => `<button type="button" class="av-scale-btn ${cls}" data-${cls === "av-fp-tier" ? "tier" : "gran"}="${val}">${lab}</button>`;
    const fpCard = `<div class="${card} mb-4">
      <div class="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <h3 class="text-cyan-400 font-bold">Floor history <span class="text-xs text-gray-500 font-normal">from actual sales</span></h3>
        <div class="flex items-center gap-2 text-xs">
          <span class="inline-flex rounded-md overflow-hidden border border-gray-600">${fpBtn("av-fp-tier", "broken", "Broken")}${fpBtn("av-fp-tier", "base", "Base")}${fpBtn("av-fp-tier", "phoenix", "Phoenix")}</span>
          <span class="inline-flex rounded-md overflow-hidden border border-gray-600">${fpBtn("av-fp-gran", "weekly", "12W")}${fpBtn("av-fp-gran", "monthly", "12M")}</span>
          <button id="av-fp-luna" type="button" class="av-scale-btn active rounded-md border border-gray-600">LUNA</button>
        </div></div>
      <div id="av-fp-chart"></div>
      <div class="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-gray-300 mt-3">
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4 h-3 rounded-sm" style="background:rgba(34,211,238,.35);border:1px solid rgba(34,211,238,.7)"></span>sales range (USD at sale)</span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4 rounded" style="height:3px;background:#fbbf24"></span>median sale</span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4 h-3 rounded-sm" style="background:rgba(34,211,238,.15);border:1.5px dashed rgba(34,211,238,.8)"></span>cheapest listing (USD range + <span class="text-cyan-300 font-semibold">--&nbsp;mid</span>)</span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4" style="height:0;border-top:2px dashed #34d399"></span>today's listing floor</span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4" style="height:0;border-top:2px solid #a78bfa"></span>LUNA price (own scale)</span>
        <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4 rounded" style="height:3px;background:#4b5563"></span>no sales</span>
      </div></div>`;

    // ----- VOLUME OVER TIME (scale toggle; chart injected by renderVolChart) -----
    const monthChart = `<div class="${card} mb-4">
      <div class="flex items-baseline justify-between mb-3">
        <h3 class="text-cyan-400 font-bold">Volume over time</h3>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-500">${_avMonths.length} months</span>
          <span class="inline-flex rounded-md overflow-hidden border border-gray-600">
            <button id="av-scale-lin" class="av-scale-btn">Linear</button><button id="av-scale-log" class="av-scale-btn active">Log</button>
          </span>
        </div>
      </div>
      <div id="av-vol-chart"></div>
      <div class="flex justify-between text-[11px] text-gray-500 mt-1"><span>${_avMonths.length ? _avMonths[0].month : ""}</span><span>Log scale keeps recent months readable next to the 2024 peak</span><span>${_avMonths.length ? _avMonths[_avMonths.length - 1].month : ""}</span></div></div>`;

    // ----- LEADERBOARDS with behaviour context -----
    const lb = A.leaderboards || {}; const hold = buildHoldingsMap();
    // 12-month net position change per wallet from marketplace trades (buys +1, sells −1 per month).
    const trendMonths = [];
    { const now = new Date(); for (let i = 11; i >= 0; i--) { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - i); trendMonths.push(d.toISOString().slice(0, 7)); } }
    const monthIdx = Object.fromEntries(trendMonths.map((m, i) => [m, i]));
    const netByAddr = {};
    salesDesc.forEach(s => {
        const m = (s.timestamp || "").slice(0, 7); const i = monthIdx[m]; if (i == null) return;
        (netByAddr[s.buyer] = netByAddr[s.buyer] || new Array(12).fill(0))[i]++;
        (netByAddr[s.seller] = netByAddr[s.seller] || new Array(12).fill(0))[i]--;
    });
    const trendSvg = (addr) => {
        const net = netByAddr[addr]; if (!net) return "";
        const yr = net.reduce((a, b) => a + b, 0);
        // Reconstruct monthly holdings level from current holdings minus later net trades
        // (marketplace trades only — stakes/transfers don't move this line).
        const heldNow = (hold[addr] && hold[addr].held) || 0;
        const levels = new Array(13).fill(0); levels[12] = heldNow;
        for (let i = 11; i >= 0; i--) levels[i] = levels[i + 1] - net[i];
        const col = yr >= 3 ? "#34d399" : yr <= -3 ? "#f87171" : "#f59e0b";
        const Wd = 150, Ht = 26, pad = 2;
        const lo = Math.min(...levels), hiV = Math.max(...levels);
        const span = Math.max(hiV - lo, 1);
        const px = (i) => pad + i * ((Wd - pad * 2) / 12);
        const py = (v) => pad + (1 - (v - lo) / span) * (Ht - pad * 2);
        let pth = "";
        levels.forEach((v, i) => { pth += (i ? " L" : "M") + ` ${px(i).toFixed(1)} ${py(v).toFixed(1)}`; });
        const dots = levels.map((v, i) => i === 0 ? "" : `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.4" fill="transparent"><title>${trendMonths[i - 1]}: ~${v} held (from marketplace trades)</title></circle>`).join("");
        return `<span class="inline-flex flex-col items-center"><svg width="${Wd}" height="${Ht}" style="display:block"><path d="${pth}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>${dots}</svg><span class="text-[10px] leading-none mt-0.5" style="color:${col}">${yr > 0 ? "+" : ""}${yr}/12m</span></span>`;
    };
    const clean = (arr) => (arr || []).filter(x => !(typeof isSystemAddress === "function" && isSystemAddress(x.address))).slice(0, 10);
    // Layout: [rank+name+behaviour | trend column (desktop only, sits in the blank middle) | count+$]
    const lbRow = (x, i) => `<div class="flex items-center gap-3 py-2 ${i ? "border-t border-gray-700/50" : ""}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2"><span class="text-gray-500 text-xs w-5 text-right flex-shrink-0">${i + 1}</span>
            <span class="truncate text-sm text-gray-200">${aLabel(x.address)}</span></div>
          <div class="pl-7 text-[11px] mt-0.5">${holdingsBlurb(hold[x.address])}</div>
        </div>
        <div class="hidden md:flex items-center justify-center flex-shrink-0" style="width:170px">${trendSvg(x.address)}</div>
        <div class="text-right flex-shrink-0">
          <div class="text-sm font-semibold text-cyan-300">${fmtUsd(x.notional_usd)}</div>
          <div class="text-xs text-gray-400">${fmtNum(x.count)}×</div>
        </div></div>`;
    const leaderboards = `<div class="grid md:grid-cols-2 gap-3 mb-4">
      <div class="${card}">${h("Top buyers", "spend · what they did with them")}${clean(lb.top_buyers).map(lbRow).join("")}</div>
      <div class="${card}">${h("Top sellers", "received · what they kept")}${clean(lb.top_sellers).map(lbRow).join("")}</div></div>`;

    // ----- MOST-TRADED NFTS -----
    const byId = {}; if (typeof allNfts !== "undefined" && Array.isArray(allNfts)) allNfts.forEach(n => { byId[String(n.id)] = n; });
    const traded = (lb.most_traded_tokens || []).slice(0, 12).map(t => {
        const n = byId[String(t.token_id)] || {};
        // Same image strategy as gallery cards: Cloudflare CDN primary, IPFS gateway fallback.
        // (Direct ipfs.io requests rate-limit on bursts, which is why tiles randomly failed.)
        const imgSrc = getImageUrl(t.token_id);
        const imgFallback = getIpfsFallbackUrl(t.token_id, n.thumbnail_image || n.image);
        return `<div class="flex flex-col items-center text-center">
          <div class="w-full aspect-square rounded-lg overflow-hidden bg-gray-900 border border-gray-700"><img src="${imgSrc}" data-fallback="${imgFallback}" loading="lazy" class="w-full h-full object-cover" onerror="if(this.dataset.fallback && this.src !== this.dataset.fallback) { this.src = this.dataset.fallback; } else { this.onerror=null; this.style.display='none'; }"></div>
          <div class="text-xs text-gray-200 mt-1">#${t.token_id}</div><div class="text-[11px] text-cyan-300">${t.sales}× · ${fmtUsd(t.notional_usd)}</div>
          ${n.rank ? `<div class="text-[10px] text-gray-500">rank ${n.rank}</div>` : ""}</div>`;
    }).join("");
    const mostTraded = `<div class="${card} mb-4">${h("Most-traded NFTs", "by sale count")}<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">${traded}</div></div>`;

    // ----- BIGGEST SALES + SALE FREQUENCY + DENOM -----
    const big10 = (E && Array.isArray(E.sales)) ? [...E.sales].sort((a, b) => (b.notional_usd || 0) - (a.notional_usd || 0)).slice(0, 10) : [];
    const bigTiles = big10.map(s => {
        const n = byId[String(s.token_id)] || {};
        return `<div class="flex flex-col items-center text-center">
          <div class="w-full aspect-square rounded-lg overflow-hidden bg-gray-900 border border-gray-700"><img src="${getImageUrl(s.token_id)}" data-fallback="${getIpfsFallbackUrl(s.token_id, n.thumbnail_image || n.image)}" loading="lazy" class="w-full h-full object-cover" onerror="if(this.dataset.fallback && this.src !== this.dataset.fallback) { this.src = this.dataset.fallback; } else { this.onerror=null; this.style.display='none'; }"></div>
          <div class="text-xs text-gray-200 mt-1">#${s.token_id}</div>
          <div class="text-[11px] font-semibold text-amber-300">${fmtUsd(s.notional_usd)}</div>
          <div class="text-[10px] text-gray-500">${fmtNum(s.amount)} ${s.denom_symbol} · ${(s.timestamp || "").slice(0, 10)}</div></div>`;
    }).join("");
    const biggestCard = `<div class="${card} mb-4">${h("Biggest sales", "all-time top 10, USD at sale")}
      <div class="grid grid-cols-3 sm:grid-cols-5 gap-3">${bigTiles}</div></div>`;
    const dist = A.sale_number_distribution || {}; const distMax = Math.max(...Object.values(dist).map(Number), 1);
    const distRows = Object.entries(dist).map(([k, v]) => `<div class="flex items-center gap-3 py-1 text-sm"><span class="w-20 text-gray-400">${k}× sold</span><div class="flex-1">${hBar(v, distMax)}</div><span class="w-14 text-right text-gray-300">${fmtNum(v)}</span></div>`).join("");
    const denom = A.denom_split || {}; const denomTot = Object.values(denom).reduce((s, d) => s + (d.count || 0), 0) || 1;
    const denomRows = Object.entries(denom).sort((a, b) => b[1].count - a[1].count).map(([sym, d]) => `<div class="flex items-center gap-3 py-1 text-sm"><span class="w-16 text-gray-300">${sym}</span><div class="flex-1">${hBar(d.count, denomTot)}</div><span class="w-24 text-right text-gray-400">${fmtNum(d.count)} sales</span></div>`).join("");
    const row3 = biggestCard + `<div class="grid md:grid-cols-2 gap-3 mb-4">
      <div class="${card}">${h("Sale frequency", "times changed hands")}${distRows}</div>
      <div class="${card}">${h("Paid in", "by sale count")}${denomRows}</div></div>`;

    // ----- compact trading-character line (replaces the confusing flip card) -----
    const fl = A.flips || {}; const ht = A.hold_time_days || {};
    const flipLine = `<div class="${card} mb-4 text-sm text-gray-400">
      <span class="text-gray-500 uppercase text-xs tracking-wider mr-2">Trading character</span>
      ${fmtNum(fl.flip_count)} flips · realized P&L <span class="${fl.realized_pnl_usd >= 0 ? "text-green-400" : "text-red-400"} font-semibold">${fl.realized_pnl_usd >= 0 ? "+" : ""}${fmtUsd(fl.realized_pnl_usd)}</span> · median hold ${(+ht.median || 0).toFixed(1)}d
      <span class="text-gray-600">— a per-wallet cost-basis view is coming to the Wallet tab</span></div>`;

    const footer = `<div class="text-center text-[11px] text-gray-600 pb-6">Chain-of-truth analytics · built ${A.builtAt ? new Date(A.builtAt).toLocaleString() : ""}</div>`;
    return hero + tiles + supplyGovRow + floorCard + fpCard + monthChart + leaderboards + mostTraded + row3 + flipLine + footer;
}

const updateAddressDropdown = (nftList) => {
    const ownerCounts = {};
    // Count NFTs *only* from the provided list (filtered or all)
    nftList.forEach(nft => {
        if (nft.owner) {
            ownerCounts[nft.owner] = (ownerCounts[nft.owner] || 0) + 1;
        }
    });

    // Sort owners by the new counts
    const sortedOwners = Object.entries(ownerCounts)
        .sort(([, countA], [, countB]) => countB - countA);

    // Remember the currently selected value before clearing
    const currentSelectedAddress = addressDropdown?.value;
    let selectionStillExists = false;

    // Clear existing options (except the first "Holders" option) for both dropdowns
    [addressDropdown, mobileAddressDropdown].forEach(dropdown => {
        if (!dropdown) return;
        while (dropdown.options.length > 1) {
            dropdown.remove(dropdown.options.length - 1);
        }
    });

    // Populate with new sorted owners and counts
    sortedOwners.forEach(([address, count]) => {
        [addressDropdown, mobileAddressDropdown].forEach(dropdown => {
            if (!dropdown) return;
            const option = document.createElement('option');
            option.value = address;
            const systemLabel = getSystemWalletLabel(address);
            const memberName = getMemberName(address);
            const shortAddr = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
            if (systemLabel) {
                option.textContent = `(${count}) ${systemLabel} - ${shortAddr}`;
            } else if (memberName) {
                option.textContent = `(${count}) ${memberName} - ${shortAddr}`;
            } else {
                option.textContent = `(${count}) ${shortAddr}`;
            }
            dropdown.appendChild(option);
        });
        // Check if the previously selected address is in the new list
        if (address === currentSelectedAddress) {
            selectionStillExists = true;
        }
    });

    // Re-select the previous address if it still exists in the filtered list
    if (selectionStillExists) {
        if (addressDropdown) addressDropdown.value = currentSelectedAddress;
        if (mobileAddressDropdown) mobileAddressDropdown.value = currentSelectedAddress;
    } else {
        // If the previously selected holder is filtered out,
        // check if the address input field still has a value.
        const currentInputAddress = searchAddressInput?.value;
        const inputAddressExists = sortedOwners.some(([adr]) => adr === currentInputAddress);
        if (!inputAddressExists) {
             if (addressDropdown) addressDropdown.value = "";
             if (mobileAddressDropdown) mobileAddressDropdown.value = "";
        } else {
            if (addressDropdown) addressDropdown.value = currentInputAddress;
            if (mobileAddressDropdown) mobileAddressDropdown.value = currentInputAddress;
        }
    }
};

// --- Collection View Logic ---
const applyFiltersAndSort = () => {
    let tempNfts = [...allNfts];

    // Address Search
    const addressSearchTerm = searchAddressInput.value.trim().toLowerCase();
    if(addressSearchTerm) {
        // Use endsWith for partial matching from the end, or full match
        tempNfts = tempNfts.filter(nft => 
            nft.owner && 
            (nft.owner.toLowerCase() === addressSearchTerm || 
            (addressSearchTerm.length < 42 && nft.owner.toLowerCase().endsWith(addressSearchTerm)))
        );
    }
    
    // --- Status Filters ---
    if (document.querySelector('.status-toggle-cb[data-key="staked"]')?.checked) {
        const sliderValue = document.querySelector('.direction-slider[data-slider-key="staked"]').value;
        if (sliderValue === '0') tempNfts = tempNfts.filter(nft => nft.staked_enterprise_legacy);
        else if (sliderValue === '1') tempNfts = tempNfts.filter(nft => nft.staked_enterprise_legacy || nft.staked_daodao);
        else if (sliderValue === '2') tempNfts = tempNfts.filter(nft => nft.staked_daodao);
    }
    if (document.querySelector('.status-toggle-cb[data-key="listed"]')?.checked) {
        // Listed on ANY marketplace the user has left switched on.
        const fields = MARKETPLACES.filter(m => activeMarketplaces.has(m.key)).map(m => m.field);
        tempNfts = tempNfts.filter(nft => fields.some(f => nft[f]));
    }
    if (document.querySelector('.status-toggle-cb[data-key="rewards"]')?.checked) {
        const sliderValue = document.querySelector('.direction-slider[data-slider-key="rewards"]').value;
        if (sliderValue === '0') tempNfts = tempNfts.filter(nft => nft.broken === true);
        else if (sliderValue === '1') tempNfts = tempNfts.filter(nft => nft.broken !== undefined); // All that have the property
        else if (sliderValue === '2') tempNfts = tempNfts.filter(nft => nft.broken === false);
    }
     if (document.querySelector('.status-toggle-cb[data-key="mint_status"]')?.checked) {
        const sliderValue = document.querySelector('.direction-slider[data-slider-key="mint_status"]').value;
        if (sliderValue === '0') tempNfts = tempNfts.filter(nft => nft.owned_by_alliance_dao === true); // Use combined DAO property
        else if (sliderValue === '2') tempNfts = tempNfts.filter(nft => nft.owned_by_alliance_dao === false);
    }
    // *** ADDED LIQUID FILTER LOGIC ***
    if (document.querySelector('.status-toggle-cb[data-key="liquid_status"]')?.checked) {
        const sliderValue = document.querySelector('.direction-slider[data-slider-key="liquid_status"]').value;
        if (sliderValue === '0') tempNfts = tempNfts.filter(nft => nft.liquid === true);
        else if (sliderValue === '2') tempNfts = tempNfts.filter(nft => nft.liquid === false);
    }
    
    // *** MATCHING TRAITS FILTER - check both old DOM element and new dynamic one ***
    const matchingToggle = document.querySelector('.status-toggle-cb[data-key="matching_traits"]') || matchingTraitsToggle;
    const matchingSlider = document.querySelector('.status-slider[data-slider-key="matching_traits"]') || matchingTraitsSlider;
    if (matchingToggle?.checked) {
        const strictLevel = matchingSlider ? parseInt(matchingSlider.value) : 0;
        tempNfts = tempNfts.filter(nft => hasMatchingTraits(nft, strictLevel));
    }
    
    const activePlanetFilters = [];
    document.querySelectorAll('.planet-toggle-cb:checked').forEach(cb => {
        const planetName = cb.dataset.key;
        const slider = document.querySelector(`.direction-slider[data-slider-key="${planetName}"]`);
        activePlanetFilters.push({ name: planetName, direction: slider.value });
    });
    if (activePlanetFilters.length > 0) {
        tempNfts = tempNfts.filter(nft => {
            const planetAttr = nft.attributes?.find(a => a.trait_type === 'Planet');
            if (!planetAttr) return false;
            return activePlanetFilters.some(filter => {
                const planetValue = planetAttr.value;
                if (filter.direction === '1') return planetValue.startsWith(filter.name);
                if (filter.direction === '0') return planetValue === `${filter.name} North`;
                if (filter.direction === '2') return planetValue === `${filter.name} South`;
                return false;
            });
        });
    }

    const activeInhabitantFilters = [];
    document.querySelectorAll('.inhabitant-toggle-cb:checked').forEach(cb => {
        const inhabitantName = cb.dataset.key;
        const slider = document.querySelector(`.gender-slider[data-slider-key="${inhabitantName}"]`);
        activeInhabitantFilters.push({ name: inhabitantName, gender: slider.value });
    });
    if (activeInhabitantFilters.length > 0) {
        tempNfts = tempNfts.filter(nft => {
            const inhabitantAttr = nft.attributes?.find(a => a.trait_type === 'Inhabitant');
            if (!inhabitantAttr) return false;
            return activeInhabitantFilters.some(filter => {
                if (!inhabitantAttr.value.startsWith(filter.name)) return false;
                if (filter.gender === '1') return true;
                if (filter.gender === '0') return inhabitantAttr.value.endsWith(' M');
                if (filter.gender === '2') return inhabitantAttr.value.endsWith(' F');
                return false;
            });
        });
    }
    
    const searchTerm = searchInput.value;
    if (searchTerm) tempNfts = tempNfts.filter(nft => nft.id.toString() === searchTerm);
    
    document.querySelectorAll('.multi-select-container').forEach(container => {
        const traitElement = container.querySelector('[data-trait]');
        if (!traitElement) return;
        const trait = traitElement.dataset.trait;
        let selectedValues = [];
        container.querySelectorAll('.multi-select-checkbox:checked').forEach(cb => selectedValues.push(cb.value));
        if (selectedValues.length === 0) return;
        tempNfts = tempNfts.filter(nft => nft.attributes?.some(attr => attr.trait_type === trait && selectedValues.includes(attr.value.toString())));
    });

    const sortValue = sortSelect.value;
    // Active-rank comparator: rank 1 = best; unranked (BBL null) always sorts to the end.
    const rankAsc = (a, b) => {
        const ra = getActiveRank(a), rb = getActiveRank(b);
        if (ra == null && rb == null) return (a.id ?? 0) - (b.id ?? 0);
        if (ra == null) return 1;
        if (rb == null) return -1;
        return ra - rb;
    };
    if (sortValue === 'rank-best' || sortValue === 'desc') {
        // Ranking: best first (default). Legacy 'desc' value maps here for old saved URLs.
        tempNfts.sort(rankAsc);
    } else if (sortValue === 'rank-worst' || sortValue === 'asc') {
        // Ranking: worst first — unranked still last (they're unranked, not worst).
        tempNfts.sort((a, b) => {
            const ra = getActiveRank(a), rb = getActiveRank(b);
            if (ra == null && rb == null) return (a.id ?? 0) - (b.id ?? 0);
            if (ra == null) return 1;
            if (rb == null) return -1;
            return rb - ra;
        });
    } else if (sortValue === 'rarity-desc') {
        // Rarity (grade) High to Low; within a grade, best active rank first
        tempNfts.sort((a, b) => {
            if ((b.rarityClass ?? 0) !== (a.rarityClass ?? 0)) return (b.rarityClass ?? 0) - (a.rarityClass ?? 0);
            return rankAsc(a, b);
        });
    } else if (sortValue === 'rarity-asc') {
        // Rarity (grade) Low to High; within a grade, best active rank first
        tempNfts.sort((a, b) => {
            if ((a.rarityClass ?? 0) !== (b.rarityClass ?? 0)) return (a.rarityClass ?? 0) - (b.rarityClass ?? 0);
            return rankAsc(a, b);
        });
    } else if (sortValue === 'id-asc') {
        // ID Low to High
        tempNfts.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    } else if (sortValue === 'id-desc') {
        // ID High to Low
        tempNfts.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    } else if (sortValue === 'price-asc' || sortValue === 'price-desc') {
        // PRICE (2026-08-12). Sort on price_usd, NOT the raw amount: listings
        // are denominated in bLUNA / SOLID / LUNA, so 125 SOLID vs 2,500 bLUNA
        // is meaningless numerically. Anything without a live USD price
        // (unlisted, or a marketplace-owned listing with no ask) sorts LAST in
        // both directions rather than pretending to be $0.
        const px = (n) => {
            const v = n.listing && n.listing.price_usd;
            return (v != null && isFinite(v)) ? Number(v) : null;
        };
        const dir = sortValue === 'price-asc' ? 1 : -1;
        tempNfts.sort((a, b) => {
            const pa = px(a), pb = px(b);
            if (pa == null && pb == null) return (a.id ?? 0) - (b.id ?? 0);
            if (pa == null) return 1;
            if (pb == null) return -1;
            return (pa - pb) * dir;
        });
    }

    filteredNfts = tempNfts;
    if (resultsCount) resultsCount.textContent = filteredNfts.length;
    updateFilterCounts(filteredNfts);
    updateAddressDropdown(filteredNfts);
    displayPage(1);
};

const handleFilterChange = () => { applyFiltersAndSort(); updateUrlState(); };

const updateUrlState = () => {
    const params = new URLSearchParams();
    const curView = new URLSearchParams(window.location.search).get('view');
    if (curView) params.set('view', curView); // keep the active tab in the URL
    if (searchAddressInput.value) params.set('address', searchAddressInput.value);
    if (searchInput.value) params.set('id', searchInput.value);
    if (sortSelect.value !== 'asc') params.set('sort', sortSelect.value);

    document.querySelectorAll('.multi-select-container').forEach(container => {
        const traitElement = container.querySelector('[data-trait]');
        if (!traitElement) return;
        const trait = traitElement.dataset.trait;
        let selectedValues = [];
        container.querySelectorAll('.multi-select-checkbox:checked').forEach(cb => selectedValues.push(cb.value));
        if (selectedValues.length > 0) params.set(trait.toLowerCase(), selectedValues.join(','));
    });

    document.querySelectorAll('.toggle-checkbox:checked').forEach(toggle => {
        // Check if it's one of the filter toggles
        if (['status-toggle-cb', 'planet-toggle-cb', 'inhabitant-toggle-cb'].some(cls => toggle.classList.contains(cls))) {
            params.set(toggle.dataset.key, 'true');
            const slider = document.querySelector(`.direction-slider[data-slider-key="${toggle.dataset.key}"]`);
            if(slider && !slider.disabled) { // Only save slider pos if it's enabled
                params.set(`${toggle.dataset.key}_pos`, slider.value);
            }
        }
    });
    
    try {
        // Use replaceState to avoid cluttering browser history
        const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`; // Keep hash
        history.replaceState({}, '', newUrl);
    } catch (e) { console.warn("Could not update URL state."); }
};

const applyStateFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    if (searchInput) searchInput.value = params.get('id') || '';
    if (searchAddressInput) searchAddressInput.value = params.get('address') || '';
    
    // Validate sort param before setting it
    const sortParam = params.get('sort');
    if (sortSelect && [...sortSelect.options].some(o => o.value === sortParam)) {
        sortSelect.value = sortParam;
    } else if (sortSelect) {
        sortSelect.value = 'rank-best'; // Default: Ranking, best first
    }
    
    document.querySelectorAll('.multi-select-container').forEach(container => {
        const traitElement = container.querySelector('[data-trait]');
        if (!traitElement) return;
        const trait = traitElement.dataset.trait.toLowerCase();
        if (!params.has(trait)) return;
        const values = params.get(trait).split(',');
        container.querySelectorAll('.multi-select-checkbox').forEach(cb => {
            if (values.includes(cb.value)) cb.checked = true;
        });
        updateMultiSelectButtonText(container);
    });

    document.querySelectorAll('.toggle-checkbox').forEach(toggle => {
        if (['status-toggle-cb', 'planet-toggle-cb', 'inhabitant-toggle-cb'].some(cls => toggle.classList.contains(cls))) {
            const key = toggle.dataset.key;
            if (params.get(key) === 'true') {
                toggle.checked = true;
                const slider = document.querySelector(`.direction-slider[data-slider-key="${key}"]`);
                if(slider) {
                    slider.disabled = false;
                    slider.value = params.get(`${key}_pos`) || '1';
                }
            }
        }
    });
};

const updateMultiSelectButtonText = (container) => {
    const buttonSpan = container.querySelector('.multi-select-button span');
    const traitCheckbox = container.querySelector('.multi-select-checkbox');
    if (!buttonSpan || !traitCheckbox) return; // Safety check
    
    const traitType = traitCheckbox.dataset.trait;
    const displayLabel = traitType === 'Rarity' ? 'Rank' : traitType; // grade dropdown is shown as "Rank"
    const checkedCount = container.querySelectorAll('.multi-select-checkbox:checked').length;
    const totalCount = container.querySelectorAll('.multi-select-checkbox').length;
    
    if (checkedCount === 0 || checkedCount === totalCount) {
        buttonSpan.textContent = `All ${displayLabel}s`;
    } else {
        buttonSpan.textContent = `${checkedCount} ${displayLabel}(s) selected`;
    }
};

const closeAllDropdowns = (exceptThisOne = null) => {
    document.querySelectorAll('.multi-select-dropdown').forEach(d => {
        if (d !== exceptThisOne) d.classList.add('hidden');
    });
    if (addressSuggestions) addressSuggestions.classList.add('hidden');
    if (walletAddressSuggestions) walletAddressSuggestions.classList.add('hidden');
};

const displayPage = (page) => {
    currentPage = page;
    if (!gallery) return;
    gallery.innerHTML = '';
    gallery.classList.remove('single-card'); // Reset single card class
    
    if (filteredNfts.length === 0) {
        showLoading(gallery, 'No NFTs match the current filters.');
        updatePaginationControls(0);
        return;
    }
    
    const totalPages = Math.ceil(filteredNfts.length / itemsPerPage);
    page = Math.max(1, Math.min(page, totalPages)); // Clamp page number
    currentPage = page; // Update global state
    
    const pageItems = filteredNfts.slice((page - 1) * itemsPerPage, page * itemsPerPage);
    pageItems.forEach(nft => gallery.appendChild(createNftCard(nft, '.trait-toggle')));
    
    // Add single-card class if only one result for mobile centering
    if (pageItems.length === 1) {
        gallery.classList.add('single-card');
    }
    
    updatePaginationControls(totalPages);
};

const createNftCard = (nft, toggleSelector) => {
    const card = document.createElement('div');
    card.className = 'nft-card bg-gray-800 border border-gray-700 rounded-xl overflow-hidden flex flex-col';
    card.addEventListener('click', () => showNftDetails(nft));
    // Primary: Cloudflare CDN, Fallback: IPFS gateway
    const imageUrl = getImageUrl(nft.id) || `https://placehold.co/300x300/1f2937/e5e7eb?text=No+Image`;
    const fallbackUrl = getIpfsFallbackUrl(nft.id, nft.thumbnail_image || nft.image);
    
    // Use shorter title format: "aDAO #XXXX" 
    const shortTitle = `aDAO #${nft.id || '?'}`;
    const fullTitle = (nft.name || `NFT #${nft.id || '?'}`).replace('The AllianceDAO NFT', 'AllianceDAO NFT');

    let traitsHtml = '';
    const visibleTraits = traitOrder.filter(t => {
        const toggle = document.querySelector(`${toggleSelector}[data-trait="${t}"]`);
        return toggle && toggle.checked;
    });
    
    visibleTraits.forEach(traitType => {
        let value = 'N/A';
        if (traitType === 'Rank') {
            // Canonical rank, honoring the Intended/BBL toggle. e.g. "Rarity 40, Rank 24"
            value = rankDisplay(nft);
        } else if (traitType === 'Rarity') {
            // Plain 1-40 grade (legacy "40/1" sub-rank display retired)
            value = nft.rarityClass != null ? `${nft.rarityClass}` : 'N/A';
        } else {
            value = nft.attributes?.find(attr => attr.trait_type === traitType)?.value || 'N/A';
        }
        traitsHtml += `<li class="flex justify-between items-center py-2 px-1 border-b border-gray-700 last:border-b-0"><span class="text-xs font-medium text-cyan-400 uppercase">${traitType}</span><span class="text-sm font-semibold text-white truncate" title="${value}">${value}</span></li>`;
    });
    
    card.innerHTML = `<div class="image-container aspect-w-1-aspect-h-1 w-full"><img src="${imageUrl}" data-fallback="${fallbackUrl}" alt="${fullTitle}" class="w-full h-full object-cover" loading="lazy" onerror="if(this.dataset.fallback && this.src !== this.dataset.fallback) { this.src = this.dataset.fallback; } else { this.onerror=null; this.src='https://placehold.co/300x300/1f2937/e5e7eb?text=Image+Error'; }"></div><div class="p-4 flex-grow flex flex-col"><h2 class="text-lg font-bold text-white mb-3 truncate" title="${fullTitle}">${shortTitle}</h2><ul class="text-sm flex-grow">${traitsHtml}</ul></div>`;
    
    const imageContainer = card.querySelector('.image-container');
    if (!imageContainer) return card; // Safety check
    
    const isDaoOwned = nft.owned_by_alliance_dao; // Use the combined property
    // Registry-driven so a new marketplace can never be missed here again
    // (Atrium-only listings previously produced no badge stack at all).
    // The eye must exist whenever there is ANYTHING overlaying the art — which
    // now includes the listing price pill and the showcase picker, not just
    // badges. A listed NFT with no other badge still needs a way to see clean art.
    const hasBadges = nft.broken || nft.staked_daodao || nft.staked_enterprise_legacy || isDaoOwned
        || MARKETPLACES.some(m => nft[m.field]) || !!nft.listing;

    if (hasBadges) {
        // --- Add Badge Visibility Toggle ---
        const toggleButton = document.createElement('button');
        toggleButton.type = 'button'; // Explicitly set type
        toggleButton.className = 'top-left-toggle';
        toggleButton.title = 'Toggle badge visibility';
        toggleButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`; // Eye icon

        toggleButton.addEventListener('click', (e) => {
            e.stopPropagation(); // IMPORTANT: Prevents the modal from opening
            const isHidden = imageContainer.classList.toggle('badges-hidden');
            toggleButton.innerHTML = isHidden 
                ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>` // Eye-off icon
                : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`; // Eye icon
        });
        imageContainer.appendChild(toggleButton);
    }


    if (nft.broken) {
        const brokenBanner = document.createElement('div');
        brokenBanner.className = 'broken-banner';
        brokenBanner.textContent = 'BROKEN';
        imageContainer.appendChild(brokenBanner);
    }

    const topRightStack = document.createElement('div');
    topRightStack.className = 'top-right-stack';

    // Helper function to add badges
    const addBadge = (src, alt) => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = alt;
        img.title = alt; // Add title for hover tooltip
        img.className = 'overlay-icon';
        topRightStack.appendChild(img);
    };

    if (isDaoOwned) addBadge('/assets/images/Alliance%20DAO%20Logo.png', 'Owned by DAO');
    if (nft.staked_daodao) addBadge('/assets/images/DAODAO.png', 'Staked on DAODAO');
    // Marketplace badges from the shared registry — Atrium was missing entirely
    // before 2026-08-12 despite having ~17 live listings.
    // A marketplace whose logo asset is absent degrades to a lettered chip
    // rather than a broken-image icon; if the asset appears later the <img>
    // simply loads and the fallback never fires.
    const addLetterBadge = (letter, alt) => {
        const el = document.createElement('span');
        el.className = 'overlay-icon overlay-letter';
        el.textContent = letter;
        el.title = alt;
        topRightStack.appendChild(el);
    };
    for (const m of MARKETPLACES) {
        if (!nft[m.field]) continue;
        const alt = `Listed on ${m.label}`;
        if (!m.icon) { addLetterBadge(m.letter || m.label[0], alt); continue; }
        const img = document.createElement('img');
        img.src = m.icon; img.alt = alt; img.title = alt; img.className = 'overlay-icon';
        img.addEventListener('error', () => {
            img.replaceWith(Object.assign(document.createElement('span'), {
                className: 'overlay-icon overlay-letter',
                textContent: m.letter || m.label[0],
                title: alt,
            }));
        }, { once: true });
        topRightStack.appendChild(img);
    }
    if (nft.staked_enterprise_legacy) addBadge('/assets/images/Enterprise.jpg', 'Staked on Enterprise');

    if (topRightStack.children.length > 0) {
        imageContainer.appendChild(topRightStack);
    }

    // LISTING PRICE (2026-08-12). The cron has captured full price data all
    // along — price_display / token symbol / price_usd — and nothing showed it.
    // Denominations differ per marketplace (bLUNA / SOLID / LUNA), so we show
    // the token amount as the headline and USD beside it for comparability.
    // A marketplace-owned listing with no ask says so rather than showing $0.
    // SHOWCASE PICKER (2026-08-12): only listed NFTs get one — an unlisted NFT
    // has no ask to advertise. Click to add/remove from the social post.
    if (showcaseEligible(nft)) {
        const pick = document.createElement('button');
        pick.type = 'button';
        // bottom-right, and tagged `overlay-icon` so the eye (which hides
        // overlays for a clean look at the art) hides this too.
        pick.className = 'showcase-pick overlay-icon' + (showcasePicks.has(String(nft.id)) ? ' picked' : '');
        pick.dataset.showcaseId = String(nft.id);
        pick.title = 'Add to social post';
        pick.textContent = '+';
        pick.addEventListener('click', (ev) => {
            ev.stopPropagation();          // don't open the detail modal
            const r = toggleShowcasePick(nft.id);
            if (r && r.full) {
                pick.textContent = 'max';
                setTimeout(() => { pick.textContent = '+'; }, 1200);
            }
        });
        imageContainer.appendChild(pick);
    }

    const priced = fmtListingPrice(nft.listing);
    if (priced) {
        const pill = document.createElement('div');
        pill.className = 'listing-price-pill';
        pill.title = `${marketplaceOf(nft) || 'Listed'}${priced.usd ? ` · ${priced.usd}` : ''}`;
        pill.innerHTML = priced.token
            ? `<span class="lp-amt">${priced.token}</span>${priced.usd ? `<span class="lp-usd">${priced.usd}</span>` : ''}`
            : `<span class="lp-amt lp-none">No price set</span>`;
        imageContainer.appendChild(pill);
    }

    return card;
};

const updatePaginationControls = (totalPages) => {
    if (!paginationControls) return;
    paginationControls.innerHTML = '';
    if (totalPages <= 1) return;
    
    const prevButton = document.createElement('button');
    prevButton.textContent = 'Previous';
    prevButton.className = 'pagination-btn';
    prevButton.disabled = currentPage === 1;
    prevButton.onclick = () => displayPage(currentPage - 1);
    paginationControls.appendChild(prevButton);
    
    const pageInfo = document.createElement('span');
    pageInfo.className = 'text-gray-400';
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    paginationControls.appendChild(pageInfo);
    
    const nextButton = document.createElement('button');
    nextButton.textContent = 'Next';
    nextButton.className = 'pagination-btn';
    nextButton.disabled = currentPage === totalPages;
    nextButton.onclick = () => displayPage(currentPage + 1);
    paginationControls.appendChild(nextButton);
};

const resetAll = () => {
    if(searchInput) searchInput.value = '';
    if(searchAddressInput) searchAddressInput.value = '';
    if(addressDropdown) addressDropdown.value = '';
    if(sortSelect) sortSelect.value = 'rank-best'; // Default: Ranking, best first
    if(matchingTraitsToggle) matchingTraitsToggle.checked = false;
    if(matchingTraitsSlider) {
        matchingTraitsSlider.value = 0;
        matchingTraitsSlider.disabled = true;
    }
    
    // Clear mobile search fields too
    if(mobileSearchAddress) mobileSearchAddress.value = '';
    if(mobileAddressDropdown) mobileAddressDropdown.value = '';
    if(searchLast4Input) searchLast4Input.value = '';
    
    document.querySelectorAll('.toggle-checkbox').forEach(toggle => {
        if (['status-toggle-cb', 'planet-toggle-cb', 'inhabitant-toggle-cb'].some(cls => toggle.classList.contains(cls))) {
            toggle.checked = false;
            const key = toggle.dataset.key;
            const slider = document.querySelector(`.direction-slider[data-slider-key="${key}"]`);
            if(slider) {
                slider.value = 1;
                slider.disabled = true;
            }
        }
    });

    document.querySelectorAll('.multi-select-container').forEach(container => {
        container.querySelectorAll('.multi-select-checkbox').forEach(cb => cb.checked = false);
        updateMultiSelectButtonText(container);
    });
    
    document.querySelectorAll('.trait-toggle').forEach(toggle => { toggle.checked = defaultTraitsOn.includes(toggle.dataset.trait); });
    
    handleFilterChange();
};


const updateFilterCounts = (currentNfts) => { // Pass in the list to count
    const newCounts = {};
    const curInhabCounts = {};
    const curPlanCounts = {};
    
    currentNfts.forEach(nft => {
        if (nft.attributes) {
            nft.attributes.forEach(attr => {
                if (!newCounts[attr.trait_type]) newCounts[attr.trait_type] = {};
                newCounts[attr.trait_type][attr.value] = (newCounts[attr.trait_type][attr.value] || 0) + 1;
                
                if (attr.trait_type === 'Inhabitant') {
                    const baseName = attr.value.replace(/ (M|F)$/, '');
                    if (!curInhabCounts[baseName]) curInhabCounts[baseName] = { total: 0, male: 0, female: 0 };
                    curInhabCounts[baseName].total++;
                    if (attr.value.endsWith(' M')) curInhabCounts[baseName].male++;
                    if (attr.value.endsWith(' F')) curInhabCounts[baseName].female++;
                }
                if (attr.trait_type === 'Planet') {
                    const baseName = attr.value.replace(/ (North|South)$/, '');
                    if (!curPlanCounts[baseName]) curPlanCounts[baseName] = { total: 0, north: 0, south: 0 };
                    curPlanCounts[baseName].total++;
                    if (attr.value.endsWith(' North')) curPlanCounts[baseName].north++;
                    if (attr.value.endsWith(' South')) curPlanCounts[baseName].south++;
                }
            });
        }
    });

    document.querySelectorAll('.multi-select-container').forEach(container => {
        const traitType = container.querySelector('[data-trait]')?.dataset.trait;
        if (!traitType) return;
        container.querySelectorAll('label').forEach(label => {
            const checkbox = label.querySelector('input');
            if (!checkbox) return;
            const value = checkbox.value;
            const countSpan = label.querySelector('.trait-count');
            const count = newCounts[traitType]?.[value] || 0;
            if (countSpan) countSpan.textContent = count;
            if (count === 0 && !checkbox.checked) {
                label.style.opacity = '0.5';
                label.style.cursor = 'not-allowed';
                checkbox.disabled = true;
            } else {
                label.style.opacity = '1';
                label.style.cursor = 'pointer';
                checkbox.disabled = false;
            }
        });
    });

    document.querySelectorAll('.inhabitant-count').forEach(countSpan => {
        const name = countSpan.dataset.countKey;
        const slider = document.querySelector(`.gender-slider[data-slider-key="${name}"]`);
        const counts = curInhabCounts[name] || { male: 0, female: 0, total: 0 };
        if (slider) {
            if (slider.value === '0') countSpan.textContent = counts.male;
            else if (slider.value === '1') countSpan.textContent = counts.total;
            else if (slider.value === '2') countSpan.textContent = counts.female;
        } else {
             countSpan.textContent = counts.total;
        }
    });

    document.querySelectorAll('.planet-count').forEach(countSpan => {
        const name = countSpan.dataset.countKey;
        const slider = document.querySelector(`.direction-slider[data-slider-key="${name}"]`);
        const counts = curPlanCounts[name] || { north: 0, south: 0, total: 0 };
        if (slider) {
            if (slider.value === '0') countSpan.textContent = counts.north;
            else if (slider.value === '1') countSpan.textContent = counts.total;
            else if (slider.value === '2') countSpan.textContent = counts.south;
        } else {
            countSpan.textContent = counts.total;
        }
    });
    // Update Status Filter Counts
    document.querySelectorAll('.status-count').forEach(countSpan => {
        const key = countSpan.dataset.countKey;
        const slider = document.querySelector(`.direction-slider[data-slider-key="${key}"]`);
        if (!slider) return;

        let count = 0;
        const list = currentNfts; // Use the passed-in list
        
        if (key === 'staked') {
             const enterpriseCount = list.filter(n => n.staked_enterprise_legacy).length;
             const daodaoCount = list.filter(n => n.staked_daodao).length;
             if(slider.value === '0') count = enterpriseCount;
             else if (slider.value === '1') count = list.filter(n => n.staked_enterprise_legacy || n.staked_daodao).length;
             else if (slider.value === '2') count = daodaoCount;
        } else if (key === 'listed') {
            // Chips, not a slider: count everything listed on an ACTIVE marketplace.
            const fields = MARKETPLACES.filter(m => activeMarketplaces.has(m.key)).map(m => m.field);
            count = list.filter(n => fields.some(f => n[f])).length;
        } else if (key === 'rewards') {
             const brokenCount = list.filter(n => n.broken === true).length;
             const unbrokenCount = list.filter(n => n.broken === false).length;
             if(slider.value === '0') count = brokenCount;
             else if (slider.value === '1') count = brokenCount + unbrokenCount;
             else if (slider.value === '2') count = unbrokenCount;
        } else if (key === 'mint_status') {
            const unmintedCount = list.filter(n => n.owned_by_alliance_dao === true).length;
            const mintedCount = list.filter(n => n.owned_by_alliance_dao === false).length;
            if(slider.value === '0') count = unmintedCount;
            else if (slider.value === '1') count = unmintedCount + mintedCount;
            else if (slider.value === '2') count = mintedCount;
        } else if (key === 'liquid_status') { // *** ADDED LIQUID COUNT ***
            const liquidCount = list.filter(n => n.liquid === true).length;
            const notLiquidCount = list.filter(n => n.liquid === false).length;
            if(slider.value === '0') count = liquidCount;
            else if (slider.value === '1') count = liquidCount + notLiquidCount;
            else if (slider.value === '2') count = notLiquidCount;
        } else if (key === 'matching_traits') {
            // Matching traits: P+I (value 0) or P+I+O (value 1)
            const strictLevel = parseInt(slider.value);
            count = list.filter(nft => hasMatchingTraits(nft, strictLevel)).length;
        }
        countSpan.textContent = count;
    });
};

// --- Modal and Preview Logic ---
const findHighestRaritySample = (filterFn) => {
    // Find the highest *score* (lowest rank)
    const matches = allNfts.filter(filterFn);
    if (matches.length === 0) return null;
    matches.sort((a, b) => (getActiveRank(a) ?? Infinity) - (getActiveRank(b) ?? Infinity)); // Best active rank first
    return matches[0];
};

const showPreviewTile = (event, traitType, value) => {
    const previewTile = document.getElementById('preview-tile');
    const container1 = document.getElementById('preview-container-1');
    const image1 = document.getElementById('preview-image-1');
    const name1 = document.getElementById('preview-name-1');
    const container2 = document.getElementById('preview-container-2');
    const image2 = document.getElementById('preview-image-2');
    const name2 = document.getElementById('preview-name-2');
    
    if (!previewTile || !container1 || !image1 || !name1 || !container2 || !image2 || !name2) return;
    
    let sample1 = null, sample2 = null;
    if (traitType === 'Object') {
        sample1 = findHighestRaritySample(nft => nft.attributes?.some(a => a.trait_type === 'Object' && a.value === value));
    } else if (traitType === 'Inhabitant' || traitType === 'Planet') {
        const slider = event.currentTarget.querySelector('input[type="range"]');
        const sliderValue = slider ? slider.value : '1';
        if (sliderValue === '1') {
            const suffix1 = traitType === 'Inhabitant' ? ' M' : ' North';
            const suffix2 = traitType === 'Inhabitant' ? ' F' : ' South';
            sample1 = findHighestRaritySample(nft => nft.attributes?.some(a => a.trait_type === traitType && a.value === value + suffix1));
            sample2 = findHighestRaritySample(nft => nft.attributes?.some(a => a.trait_type === traitType && a.value === value + suffix2));
            if (!sample1 && !sample2) sample1 = findHighestRaritySample(nft => nft.attributes?.some(a => a.trait_type === traitType && a.value.startsWith(value)));
            else if (!sample1) sample1 = sample2; // If only F/South exists, show it in box 1
        } else {
            const suffix = (traitType === 'Inhabitant' ? (sliderValue === '0' ? ' M' : ' F') : (sliderValue === '0' ? ' North' : ' South'));
            sample1 = findHighestRaritySample(nft => nft.attributes?.some(a => a.trait_type === traitType && a.value === value + suffix));
        }
    }
    
    const placeholder = `https://placehold.co/128x128/374151/9ca3af?text=N/A`;
    
    if (sample1) {
        image1.src = getImageUrl(sample1.id) || convertIpfsUrl(sample1.thumbnail_image || sample1.image) || placeholder;
        name1.textContent = sample1.attributes?.find(a => a.trait_type === traitType)?.value || value;
        container1.classList.remove('hidden');
    } else { container1.classList.add('hidden'); image1.src=''; name1.textContent=''; }
    
    if (sample2) {
        image2.src = getImageUrl(sample2.id) || convertIpfsUrl(sample2.thumbnail_image || sample2.image) || placeholder;
        name2.textContent = sample2.attributes?.find(a => a.trait_type === traitType)?.value || value;
        container2.classList.remove('hidden');
    } else { container2.classList.add('hidden'); image2.src=''; name2.textContent=''; }

    if (sample1 || sample2) {
        const tileWidth = sample2 ? 330 : 160;
        let x = event.clientX + 20;
        let y = event.clientY + 10;
        if (x + tileWidth > window.innerWidth) { x = event.clientX - tileWidth - 20; }
        if (y + previewTile.offsetHeight > window.innerHeight) { y = window.innerHeight - previewTile.offsetHeight - 10; }
        if (x < 0) x = 10;
        if (y < 0) y = 10;
        
        previewTile.style.left = `${x}px`;
        previewTile.style.top = `${y}px`;
        previewTile.classList.remove('hidden');
    } else {
        hidePreviewTile();
    }
};

const hidePreviewTile = () => {
    const previewTile = document.getElementById('preview-tile');
    if (previewTile) previewTile.classList.add('hidden');
};

const showCopyToast = (text) => {
    if (!copyToast) return;
    copyToast.textContent = text;
    copyToast.classList.add('show');
    setTimeout(() => { copyToast.classList.remove('show'); }, 2000);
}

const copyToClipboard = (textToCopy, typeName = 'Address') => {
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy).then(() => {
        const shortText = textToCopy.length > 10 ? `${textToCopy.substring(0, 5)}...${textToCopy.substring(textToCopy.length - 5)}` : textToCopy;
        showCopyToast(`Copied ${typeName}: ${shortText}`);
    }).catch(err => {
        console.error('Clipboard copy failed, falling back to execCommand:', err);
        try {
            const tempInput = document.createElement('textarea');
            tempInput.value = textToCopy;
            tempInput.style.position = 'absolute';
            tempInput.style.left = '-9999px';
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand('copy');
            document.body.removeChild(tempInput);
            const shortText = textToCopy.length > 10 ? `...` : textToCopy;
            showCopyToast(`Copied ${typeName}: ${shortText}`);
        } catch (e) {
            console.error('Fallback copy failed:', e);
            showCopyToast(`Copy Failed!`);
        }
    });
};

// Copy with verification modal
const copyWithVerification = (textToCopy) => {
    if (!textToCopy) { showCopyToast('No address to copy'); return; }
    navigator.clipboard.writeText(textToCopy).then(() => {
        if (copyVerifyModal && copyVerifyAddress) {
            copyVerifyAddress.textContent = textToCopy;
            copyVerifyModal.classList.remove('hidden');
        }
    }).catch(err => { console.error('Copy failed:', err); showCopyToast('Copy failed'); });
};

// Paste from clipboard into input field
const pasteFromClipboard = async (inputEl, callback) => {
    if (!inputEl) return;
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            inputEl.value = text.trim();
            showCopyToast('Pasted from clipboard');
            if (callback) callback();
        }
    } catch (err) {
        console.error('Paste failed:', err);
        showCopyToast('Paste failed - check permissions');
    }
};

// Handle Last 4 search input (Desktop)
const handleLast4Input = () => {
    if (!searchLast4Input || !last4Suggestions) return;
    let input = searchLast4Input.value.toLowerCase().trim();
    last4Suggestions.innerHTML = '';
    if (!input) { last4Suggestions.classList.add('hidden'); return; }
    
    // Reverse if RTL mode
    let searchPattern = last4SearchMode === 'rtl' ? input.split('').reverse().join('') : input;
    
    // Find matching addresses
    const matches = ownerAddresses.filter(addr => {
        const last4 = addr.slice(-4).toLowerCase();
        return last4.startsWith(searchPattern) || last4.includes(searchPattern);
    }).slice(0, 10);
    
    if (matches.length === 1 && matches[0].slice(-4).toLowerCase() === searchPattern) {
        searchLast4Input.value = matches[0].slice(-4);
        if (searchAddressInput) searchAddressInput.value = matches[0];
        last4Suggestions.classList.add('hidden');
        handleFilterChange();
        return;
    }
    
    if (matches.length > 0) {
        matches.forEach(addr => {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item';
            const memberName = getMemberName(addr);
            if (memberName) {
                item.innerHTML = `<span class="text-yellow-400">${memberName}</span><br><span class="text-xs text-gray-400">${addr.slice(0, -4)}</span><strong class="text-xs text-cyan-400">${addr.slice(-4)}</strong>`;
            } else {
                item.innerHTML = `<span class="text-gray-400">${addr.slice(0, -4)}</span><strong class="text-cyan-400">${addr.slice(-4)}</strong>`;
            }
            item.onclick = () => {
                searchLast4Input.value = addr.slice(-4);
                if (searchAddressInput) searchAddressInput.value = addr;
                last4Suggestions.classList.add('hidden');
                handleFilterChange();
            };
            last4Suggestions.appendChild(item);
        });
        last4Suggestions.classList.remove('hidden');
    } else { last4Suggestions.classList.add('hidden'); }
};

// Handle Member name search input (Desktop)
const handleMemberInput = () => {
    if (!searchLast4Input || !last4Suggestions) return;
    const input = searchLast4Input.value.toLowerCase().trim();
    last4Suggestions.innerHTML = '';
    if (!input) { last4Suggestions.classList.add('hidden'); return; }
    
    // Find matching member names
    const matches = memberNames.filter(m => 
        m.name.toLowerCase().includes(input)
    ).slice(0, 10);
    
    // Auto-select if exact match
    if (matches.length === 1 && matches[0].name.toLowerCase() === input) {
        searchLast4Input.value = matches[0].name;
        if (searchAddressInput) searchAddressInput.value = matches[0].address;
        last4Suggestions.classList.add('hidden');
        handleFilterChange();
        return;
    }
    
    if (matches.length > 0) {
        matches.forEach(member => {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item';
            const shortAddr = `${member.address.slice(0, 8)}...${member.address.slice(-4)}`;
            item.innerHTML = `<strong class="text-yellow-400">${member.name}</strong> <span class="text-gray-400 text-xs">${shortAddr}</span>`;
            item.onclick = () => {
                searchLast4Input.value = member.name;
                if (searchAddressInput) searchAddressInput.value = member.address;
                last4Suggestions.classList.add('hidden');
                handleFilterChange();
            };
            last4Suggestions.appendChild(item);
        });
        last4Suggestions.classList.remove('hidden');
    } else { last4Suggestions.classList.add('hidden'); }
};

// Update mobile search UI
const updateMobileSearchUI = () => {
    if (!mobileSearchAddress) return;
    [mobileAsReadBtn, mobileLast4LtrBtn, mobileLast4RtlBtn, mobileDaoMemberBtn].forEach(btn => btn?.classList.remove('bg-cyan-600', 'border-cyan-500'));
    if (mobileSearchMode === 'full' && mobileAsReadBtn) {
        mobileAsReadBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        mobileSearchAddress.placeholder = 'Paste or type address';
        mobileSearchAddress.maxLength = 100;
    } else if (mobileSearchMode === 'last4-ltr' && mobileLast4LtrBtn) {
        mobileLast4LtrBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        mobileSearchAddress.placeholder = 'As you read it';
        mobileSearchAddress.maxLength = 4;
    } else if (mobileSearchMode === 'last4-rtl' && mobileLast4RtlBtn) {
        mobileLast4RtlBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        mobileSearchAddress.placeholder = 'Last char first';
        mobileSearchAddress.maxLength = 4;
    } else if (mobileSearchMode === 'member' && mobileDaoMemberBtn) {
        mobileDaoMemberBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        mobileSearchAddress.placeholder = 'Type member name';
        mobileSearchAddress.maxLength = 50;
    }
    mobileSearchAddress.value = '';
    mobileSearchAddress.focus();
};

// Handle mobile address input
const handleMobileAddressInput = () => {
    if (!mobileSearchAddress || !mobileAddressSuggestions) return;
    const input = mobileSearchAddress.value.toLowerCase().trim();
    mobileAddressSuggestions.innerHTML = '';
    if (!input) { mobileAddressSuggestions.classList.add('hidden'); return; }
    
    let matches = [];
    if (mobileSearchMode === 'full') {
        matches = ownerAddresses.filter(addr => addr.toLowerCase().startsWith(input) || addr.toLowerCase().includes(input));
    } else if (mobileSearchMode === 'last4-ltr') {
        matches = ownerAddresses.filter(addr => addr.slice(-4).toLowerCase().startsWith(input));
    } else if (mobileSearchMode === 'last4-rtl') {
        const reversed = input.split('').reverse().join('');
        matches = ownerAddresses.filter(addr => addr.slice(-4).toLowerCase().startsWith(reversed));
    } else if (mobileSearchMode === 'member') {
        // Search member names instead
        const memberMatches = memberNames.filter(m => m.name.toLowerCase().includes(input)).slice(0, 10);
        
        if (memberMatches.length === 1 && memberMatches[0].name.toLowerCase() === input) {
            mobileSearchAddress.value = memberMatches[0].name;
            if (searchAddressInput) searchAddressInput.value = memberMatches[0].address;
            mobileAddressSuggestions.classList.add('hidden');
            handleFilterChange();
            return;
        }
        
        if (memberMatches.length > 0) {
            memberMatches.forEach(member => {
                const item = document.createElement('div');
                item.className = 'address-suggestion-item';
                const shortAddr = `${member.address.slice(0, 8)}...${member.address.slice(-4)}`;
                item.innerHTML = `<strong class="text-yellow-400">${member.name}</strong> <span class="text-gray-400 text-xs">${shortAddr}</span>`;
                item.onclick = () => {
                    mobileSearchAddress.value = member.name;
                    if (searchAddressInput) searchAddressInput.value = member.address;
                    mobileAddressSuggestions.classList.add('hidden');
                    handleFilterChange();
                };
                mobileAddressSuggestions.appendChild(item);
            });
            mobileAddressSuggestions.classList.remove('hidden');
        } else { mobileAddressSuggestions.classList.add('hidden'); }
        return; // Exit early for member search
    }
    matches = matches.slice(0, 10);
    
    if (matches.length === 1) {
        mobileSearchAddress.value = matches[0];
        if (searchAddressInput) searchAddressInput.value = matches[0];
        mobileAddressSuggestions.classList.add('hidden');
        handleFilterChange();
        return;
    }
    
    if (matches.length > 0) {
        matches.forEach(addr => {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item';
            const memberName = getMemberName(addr);
            if (memberName) {
                item.innerHTML = `<span class="text-yellow-400">${memberName}</span><br><span class="text-xs text-gray-500">${addr}</span>`;
            } else {
                item.textContent = addr;
            }
            item.onclick = () => {
                mobileSearchAddress.value = addr;
                if (searchAddressInput) searchAddressInput.value = addr;
                mobileAddressSuggestions.classList.add('hidden');
                handleFilterChange();
            };
            mobileAddressSuggestions.appendChild(item);
        });
        mobileAddressSuggestions.classList.remove('hidden');
    } else { mobileAddressSuggestions.classList.add('hidden'); }
};

// Handle Wallet page Last 4 search input (Desktop)
const handleWalletLast4Input = () => {
    if (!walletSearchLast4 || !walletLast4Suggestions) return;
    let input = walletSearchLast4.value.toLowerCase().trim();
    walletLast4Suggestions.innerHTML = '';
    if (!input) { walletLast4Suggestions.classList.add('hidden'); return; }
    
    let searchPattern = walletLast4SearchMode === 'rtl' ? input.split('').reverse().join('') : input;
    
    const matches = ownerAddresses.filter(addr => {
        const last4 = addr.slice(-4).toLowerCase();
        return last4.startsWith(searchPattern) || last4.includes(searchPattern);
    }).slice(0, 10);
    
    if (matches.length === 1 && matches[0].slice(-4).toLowerCase() === searchPattern) {
        walletSearchLast4.value = matches[0].slice(-4);
        if (walletSearchAddressInput) walletSearchAddressInput.value = matches[0];
        walletLast4Suggestions.classList.add('hidden');
        searchWallet();
        return;
    }
    
    if (matches.length > 0) {
        matches.forEach(addr => {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item';
            const memberName = getMemberName(addr);
            if (memberName) {
                item.innerHTML = `<span class="text-yellow-400">${memberName}</span><br><span class="text-xs text-gray-400">${addr.slice(0, -4)}</span><strong class="text-xs text-cyan-400">${addr.slice(-4)}</strong>`;
            } else {
                item.innerHTML = `<span class="text-gray-400">${addr.slice(0, -4)}</span><strong class="text-cyan-400">${addr.slice(-4)}</strong>`;
            }
            item.onclick = () => {
                walletSearchLast4.value = addr.slice(-4);
                if (walletSearchAddressInput) walletSearchAddressInput.value = addr;
                walletLast4Suggestions.classList.add('hidden');
                searchWallet();
            };
            walletLast4Suggestions.appendChild(item);
        });
        walletLast4Suggestions.classList.remove('hidden');
    } else { walletLast4Suggestions.classList.add('hidden'); }
};

// Update wallet mobile search UI
const updateWalletMobileSearchUI = () => {
    if (!walletMobileSearchAddress) return;
    [walletMobileAsReadBtn, walletMobileLast4LtrBtn, walletMobileLast4RtlBtn].forEach(btn => btn?.classList.remove('bg-cyan-600', 'border-cyan-500'));
    if (walletMobileSearchMode === 'full' && walletMobileAsReadBtn) {
        walletMobileAsReadBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        walletMobileSearchAddress.placeholder = 'Paste or type address';
        walletMobileSearchAddress.maxLength = 100;
    } else if (walletMobileSearchMode === 'last4-ltr' && walletMobileLast4LtrBtn) {
        walletMobileLast4LtrBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        walletMobileSearchAddress.placeholder = 'As you read it';
        walletMobileSearchAddress.maxLength = 4;
    } else if (walletMobileSearchMode === 'last4-rtl' && walletMobileLast4RtlBtn) {
        walletMobileLast4RtlBtn.classList.add('bg-cyan-600', 'border-cyan-500');
        walletMobileSearchAddress.placeholder = 'Last char first';
        walletMobileSearchAddress.maxLength = 4;
    }
    walletMobileSearchAddress.value = '';
    walletMobileSearchAddress.focus();
};

// Handle wallet mobile address input
const handleWalletMobileAddressInput = () => {
    if (!walletMobileSearchAddress || !walletMobileSuggestions) return;
    const input = walletMobileSearchAddress.value.toLowerCase().trim();
    walletMobileSuggestions.innerHTML = '';
    if (!input) { walletMobileSuggestions.classList.add('hidden'); return; }
    
    let matches = [];
    if (walletMobileSearchMode === 'full') {
        matches = ownerAddresses.filter(addr => addr.toLowerCase().startsWith(input) || addr.toLowerCase().includes(input));
    } else if (walletMobileSearchMode === 'last4-ltr') {
        matches = ownerAddresses.filter(addr => addr.slice(-4).toLowerCase().startsWith(input));
    } else if (walletMobileSearchMode === 'last4-rtl') {
        const reversed = input.split('').reverse().join('');
        matches = ownerAddresses.filter(addr => addr.slice(-4).toLowerCase().startsWith(reversed));
    }
    matches = matches.slice(0, 10);
    
    if (matches.length === 1) {
        walletMobileSearchAddress.value = matches[0];
        if (walletSearchAddressInput) walletSearchAddressInput.value = matches[0];
        walletMobileSuggestions.classList.add('hidden');
        searchWallet();
        return;
    }
    
    if (matches.length > 0) {
        matches.forEach(addr => {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item';
            item.textContent = addr;
            item.onclick = () => {
                walletMobileSearchAddress.value = addr;
                if (walletSearchAddressInput) walletSearchAddressInput.value = addr;
                walletMobileSuggestions.classList.add('hidden');
                searchWallet();
            };
            walletMobileSuggestions.appendChild(item);
        });
        walletMobileSuggestions.classList.remove('hidden');
    } else { walletMobileSuggestions.classList.add('hidden'); }
};

const showNftDetails = (nft) => {
    if (!nftModal || !nft) return;
    const imgEl = document.getElementById('modal-image');
    const titleEl = document.getElementById('modal-title');
    const traitsEl = document.getElementById('modal-traits');
    const linkEl = document.getElementById('modal-link');
    const dlBtn = document.getElementById('download-post-btn');
    
    if(!imgEl || !titleEl || !traitsEl || !linkEl || !dlBtn) return; // Safety check
    
    // Primary: Cloudflare CDN, Fallback: IPFS gateway
    const primaryUrl = getImageUrl(nft.id) || `https://placehold.co/400x400/1f2937/e5e7eb?text=No+Image`;
    const fallbackUrl = getIpfsFallbackUrl(nft.id, nft.image);
    imgEl.src = primaryUrl;
    imgEl.dataset.fallback = fallbackUrl;
    imgEl.onerror = function() {
        if (this.dataset.fallback && this.src !== this.dataset.fallback) {
            this.src = this.dataset.fallback;
        } else {
            this.onerror = null;
            this.src = 'https://placehold.co/400x400/1f2937/e5e7eb?text=Image+Error';
        }
    };
    titleEl.textContent = (nft.name || `NFT #${nft.id || '?'}`).replace('The AllianceDAO NFT', 'AllianceDAO NFT');
    
    // Helper function to get medal emoji based on rank
    const getMedalBadge = (rank) => {
        if (rank === 1) return '<span class="trait-medal gold" title="Rarest">🥇</span>';
        if (rank === 2) return '<span class="trait-medal silver" title="2nd Rarest">🥈</span>';
        if (rank === 3) return '<span class="trait-medal bronze" title="3rd Rarest">🥉</span>';
        return '';
    };
    
    // Get the "Rarity" trait value (official object rarity 1-40)
    const rarityValue = nft.attributes?.find(a => a.trait_type === 'Rarity')?.value || 'N/A';
    
    // Canonical rank line, honoring the Intended/BBL toggle (e.g. "Rarity 40, Rank 24")
    const rarityDisplay = rankDisplay(nft);
    let traitsHtml = `<div class="flex justify-between text-sm"><span class="text-gray-400">Rank:</span><span class="font-semibold text-cyan-400 text-lg">${rarityDisplay}</span></div>`;
    
    // Separator
    traitsHtml += `<div class="pt-2 mt-2 border-t border-gray-600"></div>`;
    
    // Traits with rarity info and medals
    const traitsToShow = ['Planet', 'Inhabitant', 'Object', 'Weather', 'Light'];
    traitsToShow.forEach(traitType => {
        const attr = nft.attributes?.find(a => a.trait_type === traitType);
        if (!attr) return;
        
        const rarityInfo = getTraitRarityRank(traitType, attr.value);
        let rarityBadge = '';
        let countInfo = '';
        
        if (rarityInfo) {
            rarityBadge = getMedalBadge(rarityInfo.rank);
            countInfo = `<span class="text-gray-500 text-xs ml-1">(${rarityInfo.percentage}% - ${rarityInfo.count} have)</span>`;
        }
        
        traitsHtml += `
            <div class="flex justify-between text-sm items-center">
                <span class="text-gray-400">${traitType}:</span>
                <span class="font-semibold text-white flex items-center gap-1">
                    ${rarityBadge}
                    <span class="truncate" title="${attr.value}">${attr.value || 'N/A'}</span>
                    ${countInfo}
                </span>
            </div>`;
    });
    
    // Separator line
    traitsHtml += `<div class="pt-2 mt-2 border-t border-gray-600"></div>`;
    
    // Status Text Logic
    let statusTxt = 'Unknown';
    if (nft.owned_by_alliance_dao) {
        statusTxt = 'DAO Owned (Un-minted)';
    } else if (nft.liquid === true) {
        statusTxt = 'Liquid (In Wallet)';
    } else if (nft.staked_daodao) {
        statusTxt = 'Staked (DAODAO)';
    } else if (nft.staked_enterprise_legacy) {
        statusTxt = 'Staked (Enterprise)';
    } else if (MARKETPLACES.some(m => nft[m.field])) {
        // Registry-driven: an Atrium listing used to fall through to "In Wallet".
        const mk = MARKETPLACES.find(m => nft[m.field]);
        const full = { bbl: 'BackBone Labs', atrium: 'Atrium', boost: 'Boost' }[mk.key] || mk.label;
        const px = fmtListingPrice(nft.listing);
        statusTxt = `Listed (${full})` + (px && px.token ? ` — ${px.token}${px.usd ? ` · ${px.usd}` : ''}` : '');
    } else if (nft.liquid === false) {
        statusTxt = 'In Wallet (Not Liquid)';
    }

    traitsHtml += `<div class="flex justify-between text-sm"><span class="text-gray-400">Status:</span><span class="font-semibold text-white">${statusTxt}</span></div>`;
    traitsHtml += `<div class="flex justify-between text-sm"><span class="text-gray-400">Broken:</span><span class="font-semibold text-white">${nft.broken ? 'Yes' : 'No'}</span></div>`;
    
    // Separator line
    traitsHtml += `<div class="pt-2 mt-2 border-t border-gray-600"></div>`;
    
    // Owner Info
    const ownerMemberName = getMemberName(nft.owner);
    traitsHtml += `<div class="flex justify-between text-sm items-center"><span class="text-gray-400">Owner:</span><span class="owner-address font-mono text-sm font-semibold text-white truncate cursor-pointer" title="Click to copy">${nft.owner || 'N/A'}</span></div>`;
    if (ownerMemberName) {
        traitsHtml += `<div class="flex justify-between text-sm items-center"><span class="text-gray-400">Member:</span><span class="font-semibold text-yellow-400">${ownerMemberName}</span></div>`;
    }

    // Update the DOM
    traitsEl.innerHTML = traitsHtml;
    
    // Add click listener for owner address copy
    const ownerEl = traitsEl.querySelector('.owner-address');
    if (nft.owner && ownerEl) {
        ownerEl.addEventListener('click', () => copyToClipboard(nft.owner, 'Owner Address'));
    } else if (ownerEl) {
        ownerEl.style.cursor = 'default';
        ownerEl.removeAttribute('title');
    }

    // Update image link and Download button
    linkEl.href = getImageUrl(nft.id) || convertIpfsUrl(nft.image) || '#';
    dlBtn.textContent = 'Download Post';
    dlBtn.disabled = false;
    dlBtn.onclick = () => generateShareImage(nft, dlBtn); 

    // Update hash and show modal (same as before)
    window.location.hash = nft.id || ''; 
    nftModal.classList.remove('hidden');
};

;

const hideNftDetails = () => {
    if (nftModal) nftModal.classList.add('hidden');
    // Clear hash without adding to history
    if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }
};

const findRarestTrait = (nft) => {
    if (!nft.attributes || !traitCounts) return { value: 'N/A', trait_type: 'Unknown' };

    let rarestTrait = null;
    let minCount = Infinity;

    // Find the rarest trait by actual mint count
    // Include: Planet, Inhabitant, Object (these affect the visual/value)
    // Exclude: Weather, Light (per official docs, don't factor into rarity)
    nft.attributes.forEach(attr => {
        if (traitCounts[attr.trait_type]?.[attr.value] && !['Weather', 'Light', 'Rarity'].includes(attr.trait_type)) {
            const count = traitCounts[attr.trait_type][attr.value];
            if (count < minCount) {
                minCount = count;
                rarestTrait = attr;
            }
        }
    });
    return rarestTrait || { value: 'N/A', trait_type: 'Unknown' };
};

// =============================================================================
// LISTINGS SHOWCASE (2026-08-12) — build a social post from your live listings.
// -----------------------------------------------------------------------------
// Pick up to 10 NFTs that are CURRENTLY LISTED and export a single image sized
// for X / Telegram. Each tile carries the art, the token id, and the real ask
// (token amount + USD) straight from the cron's listing data — so the graphic
// can never quote a price the marketplace isn't showing.
//
// Built on the same proven pattern as generateShareImage(): same canvas, same
// logo header, same blob-download path that already works on mobile.
//
// Selection lives in `showcasePicks` (a Set of token ids). Only listed NFTs can
// be picked — an unlisted NFT has no price to advertise.
// =============================================================================

// The site's own header logo (index.html uses this exact asset), so a social
// post looks like the site people land on. Shared by BOTH post types.
const POST_LOGO_URL = '/assets/images/Alliance%20DAO%20Logo.png';

const SHOWCASE_MAX = 10;
let showcasePicks = new Set();

// What goes ON the post. Defaults are the things a buyer asks first: what is
// it, what does it cost, where do I get it.
const showcaseOpts = {
    rank: true,          // "Rank 24 / Rarity 40"
    days: true,          // days the listing has stood
    vsFloor: true,       // + / – against that marketplace's floor
    marketplace: true,   // marketplace name
    link: false,         // full marketplace URL (long; off by default)
};

// Days-listed comes from listing-first-seen.json (the cron records when a
// listing was FIRST observed). Fetched once, lazily — the showcase is the only
// consumer outside the analytics view.
// HONEST DAYS-LISTED (2026-08-12). listing-first-seen records when the CRON
// FIRST OBSERVED a listing — not when the seller created it. The series began
// 2026-08-17, so every listing that predates tracking shares that same date and
// would otherwise render an identical, wrong "2d listed" on every tile.
// Fix: find the series start; anything first seen at that boundary is a LOWER
// BOUND and is drawn as "2d+ listed". Only listings we actually watched appear
// (first seen AFTER the boundary) get an exact age.
// DAYS LISTED — CHAIN TRUTH (corrected 2026-08-12).
// First attempt used listing-first-seen, which records when the CRON first
// OBSERVED a listing. That series began 2026-08-17, so every listing showed an
// identical "2d+" — technically honest but nearly useless.
//
// listing-history.json is the right source: it is a chain-derived lifecycle
// ledger where each listing carries `create_tx`, `from_height` and a real
// `from_ts`. The OPEN segment (to_ts === null) is the live listing, and its
// from_ts is when the seller actually listed it. 64 of 65 current listings
// match, with real ages up to ~705 days.
//
// The file is a frozen backfill (builtAt 2026-08-04), so anything listed after
// that date is absent — those fall back to first-seen and are marked "+" as a
// lower bound. Chain truth when we have it, an honest floor when we don't.
let _listingStarts = null;      // "<tokenId>|<marketplace>" -> ISO listing start
let _firstSeenFallback = null;  // tokenId -> first observed (lower bound)
let _firstSeenBoundary = null;  // series start; anything at it predates tracking

const loadListingAges = async () => {
    if (_listingStarts) return;
    _listingStarts = {}; _firstSeenFallback = {};
    const grab = async (url) => {
        try { const r = await fetch(url + '?t=' + Date.now()); return r.ok ? await r.json() : null; }
        catch { return null; }
    };
    const [hist, seen] = await Promise.all([
        grab('https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/listing-history.json'),
        grab('https://raw.githubusercontent.com/thealliancedao/tla-core/main/nfts/adao/snapshots/listing-first-seen.json'),
    ]);
    for (const rec of ((hist && hist.records) || [])) {
        if (rec.outcome !== 'active') continue;
        const open = (rec.segments || []).find(sg => !sg.to_ts);
        if (open && open.from_ts) _listingStarts[`${rec.token_id}|${rec.marketplace}`] = open.from_ts;
    }
    let earliest = null;
    const rows = (seen && (seen.entries || seen.records)) || {};
    for (const row of (Array.isArray(rows) ? rows : Object.values(rows))) {
        if (!row || !row.token_id || !row.first_seen_at) continue;
        _firstSeenFallback[String(row.token_id)] = row.first_seen_at;
        if (!earliest || row.first_seen_at < earliest) earliest = row.first_seen_at;
    }
    _firstSeenBoundary = earliest;
};

// Returns { days, atLeast } — atLeast true only when we are falling back to
// "first observed" for a listing that predates the tracking series.
const daysListed = (nft) => {
    const l = nft && nft.listing; if (!l) return null;
    const exact = _listingStarts && _listingStarts[`${nft.id}|${l.marketplace}`];
    if (exact) {
        const d = Math.floor((Date.now() - Date.parse(exact)) / 86400000);
        if (d >= 0) return { days: d, atLeast: false };
    }
    const seen = _firstSeenFallback && _firstSeenFallback[String(nft.id)];
    if (!seen) return null;
    const d = Math.floor((Date.now() - Date.parse(seen)) / 86400000);
    if (d < 0) return null;
    const atLeast = !!(_firstSeenBoundary && seen.slice(0, 10) === _firstSeenBoundary.slice(0, 10));
    return { days: d, atLeast };
};

// Floor per marketplace, computed from the live listings themselves (USD, so
// bLUNA / SOLID / LUNA asks are comparable). Only listings WITH a usd price
// count — a listing with no ask can't set a floor.
// TIER-AWARE FLOOR (2026-08-12). Comparing a Phoenix to a Broken floor is
// meaningless — they are three different assets sharing one supply, which is
// exactly the point the site's own market-cap explainer makes. So the floor a
// listing is measured against is the cheapest live ask IN ITS OWN TIER:
//   broken  — no backing claim
//   base    — unbroken, no apex trait
//   phoenix — the grade-40 apex trait
// Falls back to null (option simply not drawn) when a tier has no other ask,
// rather than borrowing another tier's number.
const showcaseTierOf = (n) => n.broken ? 'broken' : (n.rarityClass === 40 ? 'phoenix' : 'base');
const TIER_LABEL = { broken: 'broken', base: 'unbroken', phoenix: 'Phoenix' };

const tierFloors = () => {
    const out = { broken: null, base: null, phoenix: null };
    for (const n of allNfts) {
        if (!n.listing) continue;
        const v = Number(n.listing.price_usd);
        if (!isFinite(v) || v <= 0) continue;
        const t = showcaseTierOf(n);
        out[t] = out[t] == null ? v : Math.min(out[t], v);
    }
    return out;
};

const marketplaceFloors = () => {
    const out = {};
    for (const n of allNfts) {
        if (!n.listing) continue;
        const mk = marketplaceOf(n); if (!mk) continue;
        const v = Number(n.listing.price_usd);
        if (!isFinite(v) || v <= 0) continue;
        out[mk] = out[mk] == null ? v : Math.min(out[mk], v);
    }
    return out;
};

// Public marketplace URLs. Boost holds listed NFTs in its own contract and has
// no per-token public page we can link, so it is deliberately absent rather
// than guessed.
const ADAO_NFT_CONTRACT_ADDR = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const MARKETPLACE_URL = {
    BBL: (id) => `https://app.backbonelabs.io/nfts/marketplace/collections/${ADAO_NFT_CONTRACT_ADDR}/${id}`,
    // Corrected 2026-08-12 from the real Atrium URLs (the previous
    // previous atrium.market/... form was a guess and 404s):
    //   collection → https://atrium.markets/atrium/collection/<contract>?tab=listings
    //   token      → https://atrium.markets/atrium/<contract>/<id>
    Atrium: (id) => `https://atrium.markets/atrium/${ADAO_NFT_CONTRACT_ADDR}/${id}`,
};
const MARKETPLACE_COLLECTION_URL = {
    BBL: `https://app.backbonelabs.io/nfts/marketplace/collections/${ADAO_NFT_CONTRACT_ADDR}`,
    Atrium: `https://atrium.markets/atrium/collection/${ADAO_NFT_CONTRACT_ADDR}?tab=listings`,
};

const showcaseEligible = (nft) => !!(nft && nft.listing && MARKETPLACES.some(m => nft[m.field]));

const toggleShowcasePick = (id) => {
    const key = String(id);
    if (showcasePicks.has(key)) showcasePicks.delete(key);
    else {
        if (showcasePicks.size >= SHOWCASE_MAX) return { full: true };
        showcasePicks.add(key);
    }
    updateShowcaseBar();
    document.querySelectorAll(`[data-showcase-id="${key}"]`).forEach(el =>
        el.classList.toggle('picked', showcasePicks.has(key)));
    return { full: false };
};

const clearShowcase = () => {
    showcasePicks.clear();
    document.querySelectorAll('[data-showcase-id].picked').forEach(el => el.classList.remove('picked'));
    updateShowcaseBar();
};

// A floating bar appears only once something is picked — no UI noise otherwise.
const updateShowcaseBar = () => {
    let bar = document.getElementById('showcase-bar');
    if (!showcasePicks.size) { if (bar) bar.remove(); return; }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'showcase-bar';
        const optDefs = [
            ['rank', 'Rank'],
            ['days', 'Days listed'],
            ['vsFloor', 'vs floor'],
            ['marketplace', 'Marketplace'],
            ['link', 'Full link'],
        ];
        bar.innerHTML =
            `<span id="showcase-count"></span>` +
            `<div class="sc-opts">` + optDefs.map(([k, lbl]) =>
                `<label class="sc-opt" title="Include ${lbl} on each tile">` +
                `<input type="checkbox" data-opt="${k}" ${showcaseOpts[k] ? 'checked' : ''}>` +
                `<span>${lbl}</span></label>`).join('') + `</div>` +
            `<button id="showcase-build" class="sc-btn sc-primary">Build post</button>` +
            `<button id="showcase-clear" class="sc-btn">Clear</button>`;
        document.body.appendChild(bar);
        bar.querySelectorAll('[data-opt]').forEach(cb =>
            cb.addEventListener('change', () => { showcaseOpts[cb.dataset.opt] = cb.checked; }));
        bar.querySelector('#showcase-clear').addEventListener('click', clearShowcase);
        bar.querySelector('#showcase-build').addEventListener('click', (e) =>
            generateShowcaseImage(e.currentTarget));
    }
    bar.querySelector('#showcase-count').textContent =
        `${showcasePicks.size} selected${showcasePicks.size >= SHOWCASE_MAX ? ' (max)' : ''}`;
};

// Load an image with the same primary→IPFS fallback the single-NFT post uses.
const loadNftImage = (nft) => new Promise((resolve) => {
    const primary = getImageUrl(nft.id);
    const fallback = convertIpfsUrl(nft.image) || convertIpfsUrl(nft.thumbnail_image);
    if (!primary && !fallback) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = function () {
        if (fallback && this.src !== fallback) { this.src = fallback; }
        else resolve(null);           // resolve, never reject: one bad image
    };                                // must not sink the whole post
    img.src = primary || fallback;
});

const generateShowcaseImage = async (button) => {
    const picks = allNfts.filter(n => showcasePicks.has(String(n.id)) && showcaseEligible(n));
    if (!picks.length) return;
    const original = button ? button.textContent : '';
    if (button) { button.textContent = 'Building…'; button.disabled = true; }

    try {
        const logo = await new Promise((res) => {
            const l = new Image();
            l.crossOrigin = 'anonymous';
            l.onload = () => res(l);
            l.onerror = () => res(null);          // post still works without it
            // The same mark the website header uses, so a social post is visually
        // continuous with the site.
        l.src = POST_LOGO_URL;
        });
        const images = await Promise.all(picks.map(loadNftImage));
        if (showcaseOpts.days) await loadListingAges();
        // Tier floors, not marketplace floors — see tierFloors().
        const tierFloorMap = showcaseOpts.vsFloor ? tierFloors() : {};

        // Grid sized to the selection so 3 picks don't render as a mostly-empty
        // sheet: 1→1x1, 2→2x1, 3-4→2x2, 5-6→3x2, 7-9→3x3, 10→5x2.
        const n = picks.length;
        const cols = n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 9 ? 3 : 5;
        const rows = Math.ceil(n / cols);

        const canvas = document.getElementById('share-canvas');
        const ctx = canvas.getContext('2d');
        // Caption grows with the number of optional lines so text never collides.
        const extraLines = (showcaseOpts.rank ? 1 : 0) + (showcaseOpts.days || showcaseOpts.vsFloor ? 1 : 0)
            + (showcaseOpts.link ? 1 : 0);
        const PAD = 28, HEADER = 150, FOOT = 74, TILE = 320, GAP = 18;
        const CAP = 62 + extraLines * 22;
        canvas.width = PAD * 2 + cols * TILE + (cols - 1) * GAP;
        canvas.height = HEADER + PAD + rows * (TILE + CAP) + (rows - 1) * GAP + FOOT;

        // Background
        ctx.fillStyle = '#070b14';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Header band + logo
        const g = ctx.createLinearGradient(0, 0, canvas.width, 0);
        g.addColorStop(0, '#0c1220'); g.addColorStop(0.5, '#1a2744'); g.addColorStop(1, '#0c1220');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, HEADER);
        if (logo) {
            // FIT BY BOTH AXES (2026-08-12). The previous version constrained
            // WIDTH only, so a tall logo computed a height larger than the
            // header band and bled down over the first row of tiles. Scale to
            // whichever axis binds first, and keep a margin inside the band.
            const maxW = Math.min(canvas.width * 0.52, 460);
            const maxH = HEADER - 34;                       // 17px breathing room top and bottom
            const scale = Math.min(maxW / logo.width, maxH / logo.height);
            const lw = logo.width * scale, lh = logo.height * scale;
            ctx.drawImage(logo, (canvas.width - lw) / 2, (HEADER - lh) / 2, lw, lh);
        } else {
            ctx.fillStyle = '#e5e7eb';
            ctx.font = 'bold 44px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('THE ALLIANCE DAO', canvas.width / 2, HEADER / 2 + 14);
        }

        // Tiles
        picks.forEach((nft, i) => {
            const c = i % cols, r = Math.floor(i / cols);
            const x = PAD + c * (TILE + GAP);
            const y = HEADER + PAD + r * (TILE + CAP + GAP);

            ctx.fillStyle = '#0d1526';
            ctx.fillRect(x, y, TILE, TILE + CAP);

            const im = images[i];
            if (im) {
                // cover-crop so mixed aspect ratios don't distort
                const s = Math.max(TILE / im.width, TILE / im.height);
                const w = im.width * s, h = im.height * s;
                ctx.save();
                ctx.beginPath(); ctx.rect(x, y, TILE, TILE); ctx.clip();
                ctx.drawImage(im, x + (TILE - w) / 2, y + (TILE - h) / 2, w, h);
                ctx.restore();
            } else {
                ctx.fillStyle = '#1f2937';
                ctx.fillRect(x, y, TILE, TILE);
                ctx.fillStyle = '#6b7280';
                ctx.font = '16px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('image unavailable', x + TILE / 2, y + TILE / 2);
            }

            // Caption: id on the left, ask on the right — real numbers only.
            const px = fmtListingPrice(nft.listing);
            const mk = marketplaceOf(nft);
            ctx.textAlign = 'left';
            ctx.fillStyle = '#e5e7eb';
            ctx.font = 'bold 22px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(`#${nft.id}`, x + 12, y + TILE + 28);
            if (mk && showcaseOpts.marketplace) {
                ctx.fillStyle = '#64748b';
                ctx.font = '14px system-ui, sans-serif';
                ctx.fillText(mk, x + 12, y + TILE + 50);
            }
            if (px && px.token) {
                ctx.textAlign = 'right';
                ctx.fillStyle = '#67e8f9';
                ctx.font = 'bold 20px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.fillText(px.token, x + TILE - 12, y + TILE + 28);
                if (px.usd) {
                    ctx.fillStyle = '#94a3b8';
                    ctx.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
                    ctx.fillText(px.usd, x + TILE - 12, y + TILE + 50);
                }
            }

            // Optional lines. Every one is omitted rather than guessed when the
            // underlying value is missing — a post that invents a rank or a
            // days-listed figure is worse than one that simply doesn't show it.
            let ly = y + TILE + 72;
            if (showcaseOpts.rank) {
                // rankDisplay() already honours the Intended/BBL toggle and says
                // "Unranked" where BBL leaves broken NFTs unranked — reuse it so
                // the post can never disagree with the page.
                const txt = rankDisplay(nft);
                if (txt) {
                    ctx.textAlign = 'left'; ctx.fillStyle = '#cbd5e1';
                    ctx.font = '15px system-ui, sans-serif';
                    ctx.fillText(txt, x + 12, ly);
                    ly += 22;
                }
            }
            if (showcaseOpts.days || showcaseOpts.vsFloor) {
                const bits = [];
                if (showcaseOpts.days) {
                    const dl = daysListed(nft);
                    if (dl != null) {
                        // "2d+" when the listing predates our tracking — an honest
                        // lower bound instead of a confidently wrong exact age.
                        // Months/years read better than "705d listed".
                        const human = dl.days >= 365
                            ? `${(dl.days / 365).toFixed(1)}yr`
                            : (dl.days >= 60 ? `${Math.round(dl.days / 30)}mo` : `${dl.days}d`);
                        bits.push(dl.days === 0 && !dl.atLeast
                            ? 'listed today'
                            : `${human}${dl.atLeast ? '+' : ''} listed`);
                    }
                }
                if (showcaseOpts.vsFloor && px && px.usd) {
                    // LIKE-FOR-LIKE: measured against this NFT's OWN tier floor
                    // (broken / unbroken / Phoenix), never a blended one.
                    const tier = showcaseTierOf(nft);
                    const fl = tierFloorMap[tier];
                    const v = Number(nft.listing.price_usd);
                    if (fl && isFinite(v)) {
                        const diff = v - fl;
                        const label = TIER_LABEL[tier] || tier;
                        bits.push(Math.abs(diff) < 0.005
                            ? `AT ${label.toUpperCase()} FLOOR`
                            : `${diff > 0 ? '+' : '-'}$${Math.abs(diff).toLocaleString(undefined, { maximumFractionDigits: 0 })} vs ${label} floor`);
                    }
                }
                if (bits.length) {
                    ctx.textAlign = 'left';
                    ctx.fillStyle = bits.some(b => b.startsWith('AT ')) ? '#4ade80' : '#94a3b8';
                    ctx.font = '15px system-ui, sans-serif';
                    ctx.fillText(bits.join('  ·  '), x + 12, ly);
                    ly += 22;
                }
            }
            if (showcaseOpts.link && mk && MARKETPLACE_URL[mk]) {
                ctx.textAlign = 'left'; ctx.fillStyle = '#475569';
                ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
                const u = MARKETPLACE_URL[mk](nft.id).replace(/^https:\/\//, '');
                ctx.fillText(u.length > 46 ? u.slice(0, 44) + '…' : u, x + 12, ly);
            }
        });

        // Footer: totals + where to look. Only sums listings that HAVE a USD
        // value, and says how many — never implies a total it can't back.
        const usdVals = picks.map(p => Number(p.listing && p.listing.price_usd)).filter(v => isFinite(v) && v > 0);
        const totalUsd = usdVals.reduce((a, b) => a + b, 0);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#94a3b8';
        ctx.font = '19px system-ui, sans-serif';
        const totalTxt = usdVals.length
            ? `${picks.length} listed · ${usdVals.length === picks.length ? '' : `${usdVals.length} priced · `}$${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} total`
            : `${picks.length} listed`;
        ctx.fillText(totalTxt, canvas.width / 2, canvas.height - FOOT / 2 - 8);
        ctx.fillStyle = '#475569';
        ctx.font = '15px system-ui, sans-serif';
        ctx.fillText('thealliancedao.com', canvas.width / 2, canvas.height - FOOT / 2 + 16);

        // Download via blob — the same path the single-NFT post already uses,
        // because it behaves on mobile where dataURL downloads do not.
        canvas.toBlob((blob) => {
            if (!blob) { if (button) { button.textContent = 'Error'; button.disabled = false; } return; }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `AllianceDAO_Listings_${picks.length}.png`;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            if (button) { button.textContent = 'Downloaded'; setTimeout(() => { button.textContent = original; button.disabled = false; }, 1800); }
        }, 'image/png');
    } catch (e) {
        console.error('showcase build failed', e);
        if (button) { button.textContent = 'Error'; setTimeout(() => { button.textContent = original; button.disabled = false; }, 2000); }
    }
};

const generateShareImage = (nft, button) => {
    if (!button) return;
    button.textContent = 'Generating...';
    button.disabled = true;
    
    const canvas = document.getElementById('share-canvas');
    if (!canvas) {
        button.textContent = 'Error';
        return;
    }
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = "anonymous";
    
    // Primary: Cloudflare CDN, Fallback: IPFS
    const primaryUrl = getImageUrl(nft.id);
    const fallbackUrl = convertIpfsUrl(nft.image) || convertIpfsUrl(nft.thumbnail_image);
    
    if (!primaryUrl && !fallbackUrl) {
        button.textContent = 'No Image';
        setTimeout(() => { button.textContent = 'Download Post'; button.disabled = false; }, 2000);
        return;
    }
    
    // Load both NFT image and logo (text logo with "THE ALLIANCE DAO")
    const logoUrl = POST_LOGO_URL;   // shared with the listings showcase
    const logo = new Image();
    logo.crossOrigin = "anonymous";
    
    // Try primary first, fall back to IPFS on error
    img.onerror = function() {
        if (fallbackUrl && this.src !== fallbackUrl) {
            this.src = fallbackUrl;
        } else {
            button.textContent = 'Load Error';
            setTimeout(() => { button.textContent = 'Download Post'; button.disabled = false; }, 2000);
        }
    };
    img.src = primaryUrl || fallbackUrl;

    img.onload = () => {
        // Load logo after NFT image loads
        logo.onload = () => drawPostImage(canvas, ctx, img, logo, nft, button);
        logo.onerror = () => drawPostImage(canvas, ctx, img, null, nft, button); // Continue without logo if fails
        logo.src = logoUrl;
    };
};

const drawPostImage = (canvas, ctx, img, logo, nft, button) => {
  try {
    // Header with logo image (contains "THE ALLIANCE DAO" text)
    const titleHeight = 140; // Taller header to fit logo properly
    canvas.width = 1080; 
    canvas.height = 1080 + titleHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw gradient header background
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, '#0c1220');
    gradient.addColorStop(0.5, '#1a2744');
    gradient.addColorStop(1, '#0c1220');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, titleHeight);
    
    // Draw logo centered, FIT BY BOTH AXES (fixed 2026-08-12).
    // This forced the logo to 90% of the canvas WIDTH and derived its height,
    // so a tall logo computed a height taller than the header band and got
    // clipped — the arrow rendered as a cut-off wedge bleeding into the art.
    // Scale to whichever axis binds first and keep margin inside the band.
    if (logo && logo.width && logo.height) {
        const maxLogoWidth = canvas.width * 0.72;
        const maxLogoHeight = titleHeight * 0.78;      // breathing room top and bottom
        const scale = Math.min(maxLogoWidth / logo.width, maxLogoHeight / logo.height);
        const logoWidth = logo.width * scale;
        const logoHeight = logo.height * scale;
        const logoX = (canvas.width - logoWidth) / 2;
        const logoY = (titleHeight - logoHeight) / 2;
        ctx.drawImage(logo, logoX, logoY, logoWidth, logoHeight);
    } else {
        // Fallback: draw text if logo fails to load
        ctx.font = 'bold 44px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#22d3ee';
        ctx.fillText('The AllianceDAO', canvas.width / 2, titleHeight / 2);
    }
    
    // Draw the NFT image below the title
    try {
        ctx.drawImage(img, 0, titleHeight, 1080, 1080);
    } catch (e) {
        console.error("Error drawing image to canvas:", e);
        button.textContent = 'Draw Error';
        setTimeout(() => { button.textContent = 'Download Post'; button.disabled = false; }, 2000);
        return;
    }

    const getTrait = (type) => nft.attributes?.find(a => a.trait_type === type)?.value || 'N/A';
    ctx.fillStyle = 'white'; ctx.strokeStyle = 'black';
    ctx.lineWidth = 8; ctx.font = 'bold 48px Inter, sans-serif';
    ctx.lineJoin = 'round'; // Smoother text corners
    ctx.textBaseline = 'alphabetic'; // Reset baseline
    const margin = 40;
    const imageTop = titleHeight; // Offset for title

    const drawText = (text, x, y, align = 'left') => {
        ctx.textAlign = align;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
    };

    drawText(`NFT #${nft.id || '?'}`, margin, imageTop + margin + 48, 'left');
    drawText(rankDisplay(nft), canvas.width - margin, imageTop + margin + 48, 'right');
    drawText(getTrait('Planet'), margin, imageTop + 1080 - margin, 'left');
    
    let inhabitantText = getTrait('Inhabitant');
    if (inhabitantText.endsWith(' M')) inhabitantText = inhabitantText.replace(' M', ' Male');
    else if (inhabitantText.endsWith(' F')) inhabitantText = inhabitantText.replace(' F', ' Female');
    drawText(inhabitantText, canvas.width - margin, imageTop + 1080 - margin, 'right');
    
    const bannerHeight = 120;
    const bannerY = imageTop + 1080 - bannerHeight - 80;
    
    if (nft.broken) {
        ctx.fillStyle = 'rgba(220, 38, 38, 0.85)'; // Red
        ctx.fillRect(0, bannerY, canvas.width, bannerHeight);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 60px Inter, sans-serif';
        drawText('BROKEN', canvas.width / 2, bannerY + 85, 'center');
    } else {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; // Dark
        ctx.fillRect(0, bannerY, canvas.width, bannerHeight);
        const strength = findRarestTrait(nft);
        ctx.fillStyle = 'white';
            ctx.font = 'bold 40px Inter, sans-serif';
            drawText(`Rarest: ${strength.value || 'N/A'}`, canvas.width / 2, bannerY + 75, 'center');
        }
        
        // Add black border around entire image (easy to crop if needed)
        const borderWidth = 8;
        ctx.strokeStyle = '#000000'; // Black border
        ctx.lineWidth = borderWidth;
        ctx.strokeRect(borderWidth/2, borderWidth/2, canvas.width - borderWidth, canvas.height - borderWidth);
        
        // Create download - works better on mobile
        try {
            canvas.toBlob((blob) => {
                if (!blob) {
                    button.textContent = 'Blob Error';
                    setTimeout(() => { button.textContent = 'Download Post'; button.disabled = false; }, 2000);
                    return;
                }
                
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = `AllianceDAO_NFT_${nft.id || 'Unknown'}.png`;
                link.href = url;
                
                // For iOS Safari, we need to open in new tab
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                if (isIOS) {
                    // Open image in new tab - user can long-press to save
                    window.open(url, '_blank');
                    button.textContent = 'Opened!';
                } else {
                    // Standard download for other browsers
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    button.textContent = 'Downloaded!';
                }
                
                // Clean up blob URL after a delay
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            }, 'image/png');
        } catch(e) {
            console.error("Error creating download:", e);
            button.textContent = 'DL Failed';
        }

        setTimeout(() => { button.textContent = 'Download Post'; button.disabled = false; }, 2000);
    } catch (err) {
        console.error("Error in drawPostImage:", err);
        button.textContent = 'Error';
        setTimeout(() => { button.textContent = 'Download Post'; button.disabled = false; }, 2000);
    }
};

// --- Wallet View Logic ---
const calculateAndDisplayLeaderboard = () => {
    if (allNfts.length === 0) return;

    const ownerStats = {};
    const daoOwnerStats = {}; // DAO custody wallets — pinned informational rows, never ranked
    allNfts.forEach(nft => {
        if (!nft.owner) return;
        let isDaoRow = isDaoDisplayWallet(nft.owner);
        // The old Enterprise contract also custodies ~81 user stakes the cron cannot attribute
        // to a real owner (enterprise_unattributed). Those are NOT DAO-owned — keep them
        // excluded from the board entirely (status quo) rather than mislabel them as DAO.
        if (isDaoRow && nft.owner === "terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv" && !nft.enterprise_dao_broken) return;
        if (isSystemAddress(nft.owner) && !isDaoRow) return; // escrow/staking contracts stay hidden
        const bucket = isDaoRow ? daoOwnerStats : ownerStats;
        if (!bucket[nft.owner]) {
             bucket[nft.owner] = { address: nft.owner, total: 0, liquid: 0, daodaoStaked: 0, enterpriseStaked: 0, broken: 0, unbroken: 0, bblListed: 0, boostListed: 0, atriumListed: 0 };
        }
        const stats = bucket[nft.owner];
        stats.total++;
        if (nft.liquid) stats.liquid++; // Use pre-calculated liquid status
        if (nft.staked_daodao) stats.daodaoStaked++;
        if (nft.staked_enterprise_legacy) stats.enterpriseStaked++;
        if (nft.bbl_market) stats.bblListed++;
        if (nft.boost_market) stats.boostListed++;
        if (nft.atrium_market) stats.atriumListed++;
        if (nft.broken) stats.broken++;
        else stats.unbroken++; // Count unbroken
    });

    allHolderStats = Object.values(ownerStats); // No need to map, liquid is already counted
    daoPinnedStats = Object.values(daoOwnerStats).sort((a, b) => b.total - a.total);
    sortAndDisplayHolders();
};

const sortAndDisplayHolders = () => {
    const { column, direction } = holderSort;
    allHolderStats.sort((a, b) => {
        const valA = a[column];
        const valB = b[column];
        if (column === 'address') {
            return direction === 'asc' ? (valA || '').localeCompare(valB || '') : (valB || '').localeCompare(valA || '');
        } else {
            // Handle numbers
            const numA = typeof valA === 'number' ? valA : -Infinity;
            const numB = typeof valB === 'number' ? valB : -Infinity;
            return direction === 'asc' ? numA - numB : numB - numA;
        }
    });
    displayHolderPage(1);
};

const displayHolderPage = (page) => {
    if (!leaderboardTable) return;
    holderCurrentPage = page;
    leaderboardTable.innerHTML = ''; 

    const header = document.createElement('div');
    header.className = 'leaderboard-header';
    // Updated grid columns for new fields
    header.style.gridTemplateColumns = 'minmax(60px, 1fr) 2.5fr repeat(9, 1fr)'; 
    
    const createHeaderCell = (label, columnKey, isCentered = true) => {
        const isSortCol = holderSort.column === columnKey;
        const ascActive = isSortCol && holderSort.direction === 'asc';
        const descActive = isSortCol && holderSort.direction === 'desc';
        const activeClass = isSortCol ? 'sort-active' : '';
        return `<span data-sort-by="${columnKey}" class="${isCentered ? 'text-center' : ''} ${activeClass}">${label}<svg class="sort-icon w-4 h-4 inline-block ${ascActive ? 'active' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path></svg><svg class="sort-icon w-4 h-4 inline-block ${descActive ? 'active' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg></span>`;
    };

    header.innerHTML = `<span>Rank</span>` + // Rank is not sortable
                         createHeaderCell('Holder', 'address', false) +
                         createHeaderCell('Liquid', 'liquid') +
                         createHeaderCell('DAODAO', 'daodaoStaked') +
                         createHeaderCell('Enterprise', 'enterpriseStaked') +
                         createHeaderCell('Broken', 'broken') +
                         createHeaderCell('Unbroken', 'unbroken') +
                         createHeaderCell('BBL', 'bblListed') + // Shorter name
                         createHeaderCell('Boost', 'boostListed') + // Shorter name
                         createHeaderCell('Atrium', 'atriumListed') +
                         createHeaderCell('Total', 'total');

    leaderboardTable.appendChild(header);

    // Shared row builder — used by both the ranked list and the pinned DAO informational rows.
    const buildHolderRow = ({ address, ...stats }, rankCellHtml, isPinned) => {
        const item = document.createElement('div');
        item.className = 'leaderboard-row' + (isPinned ? ' dao-pinned-row' : '');
        item.style.gridTemplateColumns = 'minmax(60px, 1fr) 2.5fr repeat(9, 1fr)';
        if (isPinned) item.style.background = 'rgba(34,211,238,.06)';
        item.dataset.address = address;
        const shortAddress = address ? `terra...${address.substring(address.length - 4)}` : 'N/A';
        const daoLabel = isPinned ? (getSystemWalletLabel(address) || 'DAO Wallet') : null;
        const memberName = daoLabel || getMemberName(address);
        const displayName = memberName ? `<span class="${isPinned ? 'text-cyan-400' : 'text-yellow-400'}">${memberName}</span> <span class="text-gray-500">(${shortAddress})</span>` : shortAddress;
        
        // Stats summary for mobile view
        const statsSummary = `Liq: ${stats.liquid || 0} | DAO: ${stats.daodaoStaked || 0} | Brk: ${stats.broken || 0}`;
        item.dataset.stats = statsSummary;
        item.dataset.memberName = memberName || '';
        // Store full stats for mobile detail view
        item.dataset.liquid = stats.liquid || 0;
        item.dataset.daodao = stats.daodaoStaked || 0;
        item.dataset.enterprise = stats.enterpriseStaked || 0;
        item.dataset.broken = stats.broken || 0;
        item.dataset.unbroken = stats.unbroken || 0;
        item.dataset.bbl = stats.bblListed || 0;
        item.dataset.boost = stats.boostListed || 0;
        item.dataset.atrium = stats.atriumListed || 0;
        item.dataset.total = stats.total || 0;

        item.innerHTML = `
            ${rankCellHtml}
            <span class="text-sm truncate leaderboard-address" title="${address || ''}">${displayName}</span>
            <span class="text-center">${stats.liquid || 0}</span>
            <span class="text-center ${stats.daodaoStaked > 0 ? 'text-cyan-400' : ''}">${stats.daodaoStaked || 0}</span>
            <span class="text-center ${stats.enterpriseStaked > 0 ? 'text-gray-400' : ''}">${stats.enterpriseStaked || 0}</span>
            <span class="text-center ${stats.broken > 0 ? 'text-red-400' : ''}">${stats.broken || 0}</span>
            <span class="text-center ${stats.unbroken > 0 ? 'text-green-400' : ''}">${stats.unbroken || 0}</span>
            <span class="text-center ${stats.bblListed > 0 ? 'text-green-400' : ''}">${stats.bblListed || 0}</span>
            <span class="text-center ${stats.boostListed > 0 ? 'text-purple-400' : ''}">${stats.boostListed || 0}</span>
            <span class="text-center ${stats.atriumListed > 0 ? 'text-pink-400' : ''}">${stats.atriumListed || 0}</span>
            <span class="font-bold text-center leaderboard-total">${stats.total || 0}</span>
        `;
        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (address) {
                // Debug: Log the dataset
                console.log('Leaderboard row clicked:', address);
                console.log('Dataset:', JSON.stringify({
                    liquid: item.dataset.liquid,
                    daodao: item.dataset.daodao,
                    enterprise: item.dataset.enterprise,
                    broken: item.dataset.broken,
                    bbl: item.dataset.bbl,
                    boost: item.dataset.boost,
                    total: item.dataset.total
                }));
                
                // Highlight this row immediately
                document.querySelectorAll('#leaderboard-table .leaderboard-row').forEach(r => r.classList.remove('selected'));
                item.classList.add('selected');
                
                // Show selected wallet details on mobile IMMEDIATELY (before search)
                showSelectedWalletDetails(address, item.dataset);
                
                // Then trigger the wallet search
                walletSearchAddressInput.value = address;
                searchWallet();
            }
        });
        return item;
    };

    // Pinned aDAO custody rows (informational, unranked) — page 1 only, above the ranked list.
    if (page === 1 && daoPinnedStats.length) {
        const note = document.createElement('div');
        note.className = 'text-[11px] text-gray-500 px-2 pt-2 pb-1';
        note.textContent = 'aDAO-owned wallets — informational, excluded from ranks';
        leaderboardTable.appendChild(note);
        daoPinnedStats.forEach(s => {
            leaderboardTable.appendChild(buildHolderRow(s, `<span class="text-center font-bold text-cyan-400">DAO</span>`, true));
        });
    }

    const pageItems = allHolderStats.slice((page - 1) * holdersPerPage, page * holdersPerPage);
    pageItems.forEach((row, index) => {
        const rank = (page - 1) * holdersPerPage + index + 1;
        leaderboardTable.appendChild(buildHolderRow(row, `<span class="text-center font-bold">#${rank}</span>`, false));
    });
    updateHolderPaginationControls();
};

const updateHolderPaginationControls = () => {
    if (!leaderboardPagination) return;
    leaderboardPagination.innerHTML = '';
    const totalPages = Math.ceil(allHolderStats.length / holdersPerPage);
    if (totalPages <= 1) return;

    const prevButton = document.createElement('button');
    prevButton.textContent = 'Previous';
    prevButton.className = 'pagination-btn';
    prevButton.disabled = holderCurrentPage === 1;
    prevButton.onclick = () => displayHolderPage(holderCurrentPage - 1);
    leaderboardPagination.appendChild(prevButton);

    const pageInfo = document.createElement('span');
    pageInfo.className = 'text-gray-400';
    pageInfo.textContent = `Page ${holderCurrentPage} of ${totalPages}`;
    leaderboardPagination.appendChild(pageInfo);

    const nextButton = document.createElement('button');
    nextButton.textContent = 'Next';
    nextButton.className = 'pagination-btn';
    nextButton.disabled = holderCurrentPage === totalPages;
    nextButton.onclick = () => displayHolderPage(holderCurrentPage + 1);
    leaderboardPagination.appendChild(nextButton);
};

// Show selected wallet details on mobile
const showSelectedWalletDetails = (address, datasetOrStats) => {
    // Only show on mobile (< 768px)
    if (window.innerWidth >= 768) return;
    
    const detailsContainer = document.getElementById('selected-wallet-details');
    const addressEl = document.getElementById('selected-wallet-address');
    const statsEl = document.getElementById('selected-wallet-stats');
    const clearBtn = document.getElementById('clear-selected-wallet');
    
    if (!detailsContainer || !addressEl || !statsEl) return;
    
    // Show the container
    detailsContainer.classList.remove('hidden');
    
    // Set address with member name if available
    const shortAddr = address ? `terra...${address.substring(address.length - 4)}` : '';
    const memberName = getMemberName(address);
    if (memberName) {
        addressEl.innerHTML = `<span class="text-yellow-400">${memberName}</span> <span class="text-gray-400">(${shortAddr})</span>`;
    } else {
        addressEl.textContent = shortAddr;
    }
    addressEl.title = address;
    
    // Get values from dataset (all are strings)
    const total = datasetOrStats.total || '0';
    const liquid = datasetOrStats.liquid || '0';
    const daodao = datasetOrStats.daodao || '0';
    const enterprise = datasetOrStats.enterprise || '0';
    const broken = datasetOrStats.broken || '0';
    const unbroken = datasetOrStats.unbroken || '0';
    const bbl = datasetOrStats.bbl || '0';
    const boost = datasetOrStats.boost || '0';
    const atrium = datasetOrStats.atrium || '0';
    
    // Build stats grid - Total prominently at top
    statsEl.innerHTML = `
        <div class="col-span-3 bg-cyan-900/50 rounded p-2 mb-1">
            <div class="text-cyan-400 text-xs">Total NFTs</div>
            <div class="text-white font-bold text-lg">${total}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-gray-400 text-xs">Liquid</div>
            <div class="text-white font-bold">${liquid}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-cyan-400 text-xs">DAODAO</div>
            <div class="text-white font-bold">${daodao}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-gray-400 text-xs">Enterprise</div>
            <div class="text-white font-bold">${enterprise}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-red-400 text-xs">Broken</div>
            <div class="text-white font-bold">${broken}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-green-400 text-xs">Unbroken</div>
            <div class="text-white font-bold">${unbroken}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-green-400 text-xs">BBL</div>
            <div class="text-white font-bold">${bbl}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-purple-400 text-xs">Boost</div>
            <div class="text-white font-bold">${boost}</div>
        </div>
        <div class="bg-gray-700/50 rounded p-2">
            <div class="text-pink-400 text-xs">Atrium</div>
            <div class="text-white font-bold">${atrium}</div>
        </div>
    `;
    
    // Clear button handler
    if (clearBtn) {
        clearBtn.onclick = () => {
            detailsContainer.classList.add('hidden');
            document.querySelectorAll('#leaderboard-table .leaderboard-row').forEach(r => r.classList.remove('selected'));
        };
    }
};

// --- Map View Logic ---
// Map listeners
const handleMapContextMenu = (e) => e.preventDefault();
const handleMapMouseDown = (e) => {
    e.preventDefault();
    if (e.button === 1 || e.ctrlKey || e.metaKey) { // Middle mouse or Ctrl/Cmd click
        isRotating = true;
        isPanning = false;
        if(spaceCanvas) spaceCanvas.style.cursor = 'ew-resize';
    } else if (e.button === 0) { // Left click
        isPanning = true;
        isRotating = false;
        if(spaceCanvas) spaceCanvas.style.cursor = 'grabbing';
    }
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
};
const handleMapMouseUp = (e) => {
    e.preventDefault();
    isPanning = false;
    isRotating = false;
    if(spaceCanvas) spaceCanvas.style.cursor = 'grab';
};
const handleMapMouseLeave = () => {
    if (isPanning || isRotating) {
        isPanning = false;
        isRotating = false;
        if(spaceCanvas) spaceCanvas.style.cursor = 'grab';
    }
};
const handleMapMouseMove = (e) => {
    if (!spaceCanvas) return;
    const rect = spaceCanvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // Skip if canvas not visible

    // Check if mouse is inside canvas bounds
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (mouseX < 0 || mouseX > rect.width || mouseY < 0 || mouseY > rect.height) {
        // Mouse left the canvas area, stop panning/rotating
        if (isPanning || isRotating) {
            isPanning = false;
            isRotating = false;
            if(spaceCanvas) spaceCanvas.style.cursor = 'grab';
        }
        return;
    }

    // Convert mouse coords to world coords - use CSS dimensions (rect) not canvas dimensions
    const currentZoom = (mapZoom === 0) ? 0.0001 : mapZoom; // Avoid divide by zero
    const worldX = (mouseX - (rect.width / 2 + mapOffsetX)) / currentZoom;
    const worldY = (mouseY - (rect.height / 2 + mapOffsetY)) / currentZoom;
    const sinR = Math.sin(-mapRotation);
    const cosR = Math.cos(-mapRotation);
    const rotatedX = worldX * cosR - worldY * sinR;
    const rotatedY = worldX * sinR + worldY * cosR;

    if (isPanning || isRotating) {
        if (isPanning) {
            mapOffsetX += e.clientX - lastMouseX;
            mapOffsetY += e.clientY - lastMouseY;
        } else if (isRotating) {
            mapRotation += (e.clientX - lastMouseX) / 300; // Adjust rotation speed
        }
    } else {
        // Hover logic
        let isAnyObjectHovered = false;
        // Iterate backwards to check top-most items first
        for (let i = mapObjects.length - 1; i >= 0; i--) {
            const obj = mapObjects[i];
            if (!obj || typeof obj.x !== 'number' || typeof obj.y !== 'number' || typeof obj.width !== 'number' || typeof obj.height !== 'number' || typeof obj.scale !== 'number') continue;
            
            const displayWidth = obj.width * obj.scale;
            const displayHeight = obj.height * obj.scale;
            const halfWidth = displayWidth / 2;
            const halfHeight = displayHeight / 2;

            const isHovered = (rotatedX >= obj.x - halfWidth && rotatedX <= obj.x + halfWidth && rotatedY >= obj.y - halfHeight && rotatedY <= obj.y + halfHeight);
            
            obj.isFrozen = isHovered; // Freeze rotation on hover

            if (isHovered && (obj.address || ['daodao', 'bbl', 'boost', 'enterprise'].includes(obj.id))) {
                isAnyObjectHovered = true;
                break; // Stop checking once we find a clickable hover
            }
        }
        if(spaceCanvas) spaceCanvas.style.cursor = isAnyObjectHovered ? 'pointer' : 'grab';
    }
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
};
const handleMapWheel = (e) => {
    e.preventDefault();
    if (!spaceCanvas) return;
    const rect = spaceCanvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const zoomFactor = 1.1;
    const minZoom = 0.1, maxZoom = 5;
    
    const currentZoom = (mapZoom === 0) ? 0.0001 : mapZoom;
    
    // Mouse position in world space before zoom - use CSS dimensions (rect)
    const mouseBeforeZoomX = (mouseX - (rect.width / 2 + mapOffsetX)) / currentZoom;
    const mouseBeforeZoomY = (mouseY - (rect.height / 2 + mapOffsetY)) / currentZoom;

    let newZoom;
    if (e.deltaY < 0) { // Zoom in
        newZoom = Math.min(maxZoom, currentZoom * zoomFactor);
    } else { // Zoom out
        newZoom = Math.max(minZoom, currentZoom / zoomFactor);
    }
    if (newZoom <= 0) newZoom = minZoom; // Prevent zero or negative zoom

    // Mouse position in world space after zoom - use CSS dimensions (rect)
    const mouseAfterZoomX = (mouseX - (rect.width / 2 + mapOffsetX)) / newZoom;
    const mouseAfterZoomY = (mouseY - (rect.height / 2 + mapOffsetY)) / newZoom;

    // Adjust offset to keep mouse position stable
    mapOffsetX += (mouseAfterZoomX - mouseBeforeZoomX) * newZoom;
    mapOffsetY += (mouseAfterZoomY - mouseBeforeZoomY) * newZoom;
    mapZoom = newZoom;
};
const handleMapClick = (e) => {
    if (!spaceCanvas) return;
    const rect = spaceCanvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Use CSS dimensions (rect) not canvas dimensions (which are DPI-scaled)
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const currentZoom = (mapZoom === 0) ? 0.0001 : mapZoom;
    // Use rect dimensions for coordinate transformation (matches rendering)
    const worldX = (mouseX - (rect.width / 2 + mapOffsetX)) / currentZoom;
    const worldY = (mouseY - (rect.height / 2 + mapOffsetY)) / currentZoom;
    const sinR = Math.sin(-mapRotation);
    const cosR = Math.cos(-mapRotation);
    const rotatedX = worldX * cosR - worldY * sinR;
    const rotatedY = worldX * sinR + worldY * cosR;

    let clickedObject = null;
    let closestDistance = Infinity;
    
    // Find the CLOSEST object to click point (not just first match)
    for (let i = mapObjects.length - 1; i >= 0; i--) {
        const obj = mapObjects[i];
        if (!obj || typeof obj.x !== 'number' || typeof obj.y !== 'number' || typeof obj.width !== 'number' || typeof obj.height !== 'number' || typeof obj.scale !== 'number') continue;

        const displayWidth = obj.width * obj.scale;
        const displayHeight = obj.height * obj.scale;
        // Minimum clickable area for small objects
        const minClickArea = 40;
        const halfWidth = Math.max(displayWidth / 2, minClickArea);
        const halfHeight = Math.max(displayHeight / 2, minClickArea);

        // Check if click is within this object's bounds
        if (rotatedX >= obj.x - halfWidth && rotatedX <= obj.x + halfWidth && rotatedY >= obj.y - halfHeight && rotatedY <= obj.y + halfHeight) {
            // Calculate distance from click to object center
            const dx = rotatedX - obj.x;
            const dy = rotatedY - obj.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // Keep the closest object
            if (distance < closestDistance) {
                closestDistance = distance;
                clickedObject = obj;
            }
        }
    }

    if (clickedObject) {
        console.log("Map click on object:", clickedObject);
        if (clickedObject.address) {
            showWalletExplorerModal(clickedObject.address);
        } else if (clickedObject.id === 'boost') {
            // Boost ship shows just a warning banner, not the full leaderboard
            showBoostWarningBanner();
        } else if (['daodao', 'bbl', 'enterprise'].includes(clickedObject.id)) {
             showSystemLeaderboardModal(clickedObject.id);
        }
    }
};
const handleMapResize = debounce(() => {
    console.log("Resize detected, re-initializing map.");
    isMapInitialized = false; // Force re-init
    mapOffsetX = 0; // Reset pan
    mapOffsetY = 0;
    if (mapView && !mapView.classList.contains('hidden')) {
        initializeStarfield(); // Only re-init if map is visible
    }
}, 250);

let mapListenersAdded = false;
let touchState = { 
    startDist: 0, 
    startZoom: 1, 
    lastX: 0, 
    lastY: 0, 
    isPinching: false,
    pinchCenterX: 0,
    pinchCenterY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    startX: 0,
    startY: 0,
    startTime: 0
};

function addMapListeners() {
    if (mapListenersAdded || !spaceCanvas) return;
    console.log("Adding map listeners");
    spaceCanvas.addEventListener('contextmenu', handleMapContextMenu);
    spaceCanvas.addEventListener('mousedown', handleMapMouseDown);
    window.addEventListener('mouseup', handleMapMouseUp); // Listen on window for mouseup
    spaceCanvas.addEventListener('mouseleave', handleMapMouseLeave);
    spaceCanvas.addEventListener('mousemove', handleMapMouseMove);
    spaceCanvas.addEventListener('wheel', handleMapWheel, { passive: false });
    spaceCanvas.addEventListener('click', handleMapClick);
    
    // Touch events for mobile
    spaceCanvas.addEventListener('touchstart', handleMapTouchStart, { passive: false });
    spaceCanvas.addEventListener('touchmove', handleMapTouchMove, { passive: false });
    spaceCanvas.addEventListener('touchend', handleMapTouchEnd, { passive: false });
    
    mapListenersAdded = true;
}

function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function getTouchCenter(touches) {
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2
    };
}

function handleMapTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
        // Pinch zoom start
        touchState.isPinching = true;
        touchState.startDist = getTouchDistance(e.touches);
        touchState.startZoom = mapZoom;
        touchState.startOffsetX = mapOffsetX;
        touchState.startOffsetY = mapOffsetY;
        
        // Get pinch center relative to canvas
        const rect = spaceCanvas.getBoundingClientRect();
        const center = getTouchCenter(e.touches);
        touchState.pinchCenterX = center.x - rect.left;
        touchState.pinchCenterY = center.y - rect.top;
    } else if (e.touches.length === 1) {
        // Single finger - could be pan or tap
        touchState.isPinching = false;
        touchState.lastX = e.touches[0].clientX;
        touchState.lastY = e.touches[0].clientY;
        // Record start position and time for tap detection
        touchState.startX = e.touches[0].clientX;
        touchState.startY = e.touches[0].clientY;
        touchState.startTime = Date.now();
        isPanning = true;
    }
}

function handleMapTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2 && touchState.isPinching) {
        // Pinch zoom - zoom toward pinch center
        const currentDist = getTouchDistance(e.touches);
        const scale = currentDist / touchState.startDist;
        const newZoom = Math.max(0.3, Math.min(4, touchState.startZoom * scale));
        
        // Get current pinch center
        const rect = spaceCanvas.getBoundingClientRect();
        const center = getTouchCenter(e.touches);
        const currentPinchX = center.x - rect.left;
        const currentPinchY = center.y - rect.top;
        
        // The key insight: we want the point under our fingers to stay under our fingers
        // Before zoom: worldX = (screenX - offsetX) / zoom
        // After zoom:  worldX = (screenX - newOffsetX) / newZoom
        // For the point to stay the same: newOffsetX = screenX - worldX * newZoom
        
        // Calculate the world point that was under the original pinch center
        const worldX = (touchState.pinchCenterX - touchState.startOffsetX) / touchState.startZoom;
        const worldY = (touchState.pinchCenterY - touchState.startOffsetY) / touchState.startZoom;
        
        // Calculate new offset to keep that world point under the current pinch center
        mapOffsetX = currentPinchX - worldX * newZoom;
        mapOffsetY = currentPinchY - worldY * newZoom;
        
        mapZoom = newZoom;
    } else if (e.touches.length === 1 && isPanning) {
        // Pan
        const dx = e.touches[0].clientX - touchState.lastX;
        const dy = e.touches[0].clientY - touchState.lastY;
        mapOffsetX += dx;
        mapOffsetY += dy;
        touchState.lastX = e.touches[0].clientX;
        touchState.lastY = e.touches[0].clientY;
    }
}

function handleMapTouchEnd(e) {
    e.preventDefault();
    
    // Detect tap (single touch, short duration, minimal movement)
    if (!touchState.isPinching && e.changedTouches.length === 1) {
        const touch = e.changedTouches[0];
        const dx = Math.abs(touch.clientX - touchState.startX);
        const dy = Math.abs(touch.clientY - touchState.startY);
        const elapsed = Date.now() - touchState.startTime;
        
        console.log('Touch end - dx:', dx, 'dy:', dy, 'elapsed:', elapsed);
        
        // If movement is small and duration is short, treat as tap
        if (dx < 20 && dy < 20 && elapsed < 500) {
            console.log('Detected as TAP - calling handleMapClick');
            // Call handleMapClick directly with touch coordinates
            handleMapClick({ clientX: touch.clientX, clientY: touch.clientY });
        }
    }
    
    touchState.isPinching = false;
    isPanning = false;
}

const initializeStarfield = () => {
    if (!spaceCanvas) { console.error("Canvas not found!"); return; }
    
    if (isMapInitialized && globalAnimationFrameId) {
        console.log("Map already running.");
        return; // Already initialized and running
    }
    
    if (isMapInitialized && !globalAnimationFrameId) {
        console.log("Restarting map animation frame.");
        animate(); // Was initialized but stopped, restart animation
        return;
    }
    
    console.log("Initializing starfield...");
    const ctx = spaceCanvas.getContext('2d');
    if (!ctx) { console.error("Could not get 2D context"); return; }
    
    // Reset state
    mapStars = [];
    mapObjects = [];
    mapZoom = 0.15;
    mapRotation = 0;
    mapOffsetX = 0;
    mapOffsetY = 0;
    isPanning = false;
    isRotating = false;
    lastMouseX = 0;
    lastMouseY = 0;
    const minZoom = 0.1, maxZoom = 5;

    function setCanvasSize() {
        // Use clientWidth/Height for responsive sizing
        const dpr = window.devicePixelRatio || 1;
        const rect = spaceCanvas.getBoundingClientRect();
        
        if (spaceCanvas.width !== rect.width * dpr || spaceCanvas.height !== rect.height * dpr) {
            spaceCanvas.width = rect.width * dpr;
            spaceCanvas.height = rect.height * dpr;
            ctx.scale(dpr, dpr); // Scale context for high-DPI
            console.log(`Canvas resized to: ${spaceCanvas.width}x${spaceCanvas.height} (scaled to ${rect.width}x${rect.height})`);
            return true; // Size changed
        }
        return false; // Size was already correct
    }
    
    function createStars() {
        mapStars = [];
        const w = spaceCanvas.clientWidth, h = spaceCanvas.clientHeight;
        if (w === 0 || h === 0) return;
        const starCount = (w * h * 4) / 1000; 
        for (let i = 0; i < starCount; i++) {
            mapStars.push({
                x: (Math.random() - 0.5) * w * 10, // Spread stars wide
                y: (Math.random() - 0.5) * h * 10,
                radius: Math.random() * 1.5 + 0.5,
                alpha: Math.random(),
                twinkleSpeed: Math.random() * 0.03 + 0.005,
                twinkleDirection: 1
            });
        }
    }

    function drawGalaxy() {
        if (!ctx || !spaceCanvas) return;
        
        // Use clientWidth/Height for drawing dimensions
        const w = spaceCanvas.clientWidth;
        const h = spaceCanvas.clientHeight;
        
        ctx.save();
        ctx.clearRect(0, 0, w, h); // Clear based on CSS size
        
        if (w === 0 || h === 0) { ctx.restore(); return; } // Don't draw if hidden

        ctx.translate(w / 2 + mapOffsetX, h / 2 + mapOffsetY);
        ctx.scale(mapZoom, mapZoom);
        ctx.rotate(mapRotation);

        mapStars.forEach(star => {
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2, false);
            ctx.fillStyle = `rgba(255, 255, 255, ${star.alpha})`;
            ctx.fill();
        });
        
        const systemLineColors = {
            daodao: 'rgba(56, 189, 248, 0.7)', // Blue
            bbl: 'rgba(16, 185, 129, 0.7)', // Green
            boost: 'rgba(168, 85, 247, 0.7)', // Purple
            enterprise: 'rgba(56, 189, 248, 0.7)' // Blue
        };

        mapObjects.forEach(obj => {
            if (obj.lineTargetId) {
                const target = mapObjects.find(t => t.id === obj.lineTargetId);
                if (target) {
                    ctx.beginPath();
                    ctx.moveTo(obj.x, obj.y);
                    if (obj.lineTargetId === 'enterprise') {
                        const angle = Math.atan2(obj.y - target.y, obj.x - target.x);
                        const targetWidth = (typeof target.width === 'number' && target.width > 0) ? target.width : 100;
                        const targetScale = (typeof target.scale === 'number' && target.scale > 0) ? target.scale : 0.1;
                        const edgeRadius = (targetWidth * targetScale / 2) * 0.45; 
                        ctx.lineTo(target.x + Math.cos(angle) * edgeRadius, target.y + Math.sin(angle) * edgeRadius);
                    } else if (obj.id.startsWith('satellite')) {
                        ctx.lineTo(target.x, target.y);
                        const mothership = mapObjects.find(m => m.id === `mothership_${obj.system}_${obj.address}`);
                        if(mothership) ctx.lineTo(mothership.x, mothership.y);
                    } else {
                         ctx.lineTo(target.x, target.y);
                    }
                    ctx.strokeStyle = systemLineColors[obj.system] || 'grey';
                    ctx.lineWidth = 2 / mapZoom;
                    ctx.stroke();
                }
            }
        });

        mapObjects.forEach(obj => {
            if (!obj.img || !obj.img.complete || !(obj.width > 0) || !(obj.height > 0)) return;
            
            let displayWidth = obj.width * obj.scale;
            let displayHeight = obj.height * obj.scale;
            
            ctx.save();
            ctx.translate(obj.x, obj.y);
            ctx.rotate(obj.rotation || 0);
            try {
                ctx.drawImage(obj.img, -displayWidth / 2, -displayHeight / 2, displayWidth, displayHeight);
            } catch (e) {
                // console.error("Error drawing map image:", e, obj.id);
            }
            ctx.restore();

            if(obj.textAbove || obj.textBelow) {
                ctx.save();
                ctx.translate(obj.x, obj.y);
                ctx.rotate(-mapRotation); // Counter-rotate text
                ctx.fillStyle = '#FFFFFF';
                ctx.textAlign = 'center';
                const textScale = 1 / mapZoom;
                if (obj.textAbove) {
                    ctx.font = `bold ${18 * textScale}px Inter`;
                    ctx.fillText(obj.textAbove, 0, -displayHeight / 2 - (10 * textScale));
                }
                if (obj.textBelow) {
                     ctx.font = `${16 * textScale}px Inter`;
                     ctx.fillStyle = '#9ca3af';
                     ctx.fillText(obj.textBelow, 0, displayHeight / 2 + (20 * textScale));
                }
                ctx.restore();
            }
        });

        ctx.restore();
    }

    function updateStars() {
        mapStars.forEach(star => {
            star.alpha += star.twinkleSpeed * star.twinkleDirection;
            if (star.alpha > 1 || star.alpha < 0) {
                star.alpha = Math.max(0, Math.min(1, star.alpha)); // Clamp
                star.twinkleDirection *= -1;
            }
        });
    }
    
    function updateObjectRotations() {
        mapObjects.forEach(obj => {
            if (obj.rotationSpeed && !obj.isFrozen) {
                obj.rotation = (obj.rotation || 0) + obj.rotationSpeed;
            }
        });
    }

    function animate() {
        if (!isMapInitialized || !spaceCanvas || !document.body.contains(spaceCanvas) || mapView.classList.contains('hidden')) {
            if (globalAnimationFrameId) {
                cancelAnimationFrame(globalAnimationFrameId);
                globalAnimationFrameId = null;
                console.log("Stopping map animation.");
            }
            return;
        }
        
        setCanvasSize(); // Check size every frame
        updateStars();
        updateObjectRotations();
        drawGalaxy();
        globalAnimationFrameId = requestAnimationFrame(animate);
    }
    
    function addMapObject(config, preloadedImages) {
        const img = preloadedImages[config.imageId];
        if (!img || !img.width || !img.height) {
            console.error(`Image with ID ${config.imageId} not preloaded or has no dimensions.`);
            return;
        }
        mapObjects.push({ 
            ...config, 
            img: img, 
            width: img.width, 
            height: img.height, 
            isFrozen: false, 
            rotation: config.rotation || 0 
        });
    }

    function initMap() {
        console.log("initMap called");
        if (globalAnimationFrameId) {
            cancelAnimationFrame(globalAnimationFrameId);
            globalAnimationFrameId = null;
        }
        
        if (!spaceCanvas) return;
        setCanvasSize(); // Set size immediately
        if (spaceCanvas.width === 0 || spaceCanvas.height === 0) {
            console.error("Canvas has zero dimensions in initMap. Aborting.");
            return;
        }

        mapObjects = [];
        createStars();
        
        // Images from aDAO-Image-Planets-Empty repo
        const imageAssets = {
            daodao: '/assets/planets/daodao-planet.png',
            bbl: '/assets/planets/bbl-planet.png',
            boost: '/assets/planets/boost-ship.png',
            enterprise: '/assets/planets/enterprise-blackhole.png',
            allianceLogo: '/assets/images/aDAO%20Logo%20No%20Background.png',
            terra: '/assets/planets/Terra.PNG'
        };

        const imagePromises = Object.entries(imageAssets).map(([id, url]) => {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => resolve({ id, img });
                img.onerror = (e) => {
                    console.error(`Failed to load image: ${id} from ${url}`, e);
                    reject(new Error(`Failed to load ${id}`));
                };
                // Don't do the replace logic, URL is already raw
                img.src = url;
            });
        });

        Promise.all(imagePromises).then(loadedImageArray => {
            const preloadedImages = loadedImageArray.reduce((acc, {id, img}) => {
                acc[id] = img;
                return acc;
            }, {});
            
            setCanvasSize(); // Set size again in case it changed during load
            if (spaceCanvas.width === 0 || spaceCanvas.height === 0) {
                 console.error("Canvas has zero dimensions after image load. Aborting.");
                 isMapInitialized = false;
                 return;
            }
            
            buildGalaxySystems(preloadedImages);
            isMapInitialized = true;
            console.log("Map initialized, starting animation.");
            animate(); // Start the animation loop

        }).catch(error => {
            console.error("Error loading system images:", error);
            isMapInitialized = false;
        });
    }
    
    function buildGalaxySystems(preloadedImages) {
        const w = spaceCanvas.clientWidth, h = spaceCanvas.clientHeight;
        if (w === 0 || h === 0) {
            console.error("Canvas zero dimensions, cannot build galaxy");
            return;
        }

        const systemCenters = {
            daodao: { x: 0, y: -h * 2 },
            bbl: { x: -w * 2, y: 0 },
            boost: { x: w * 2, y: 0 },
            enterprise: { x: 0, y: h * 2 }
        };

        addMapObject({
            id: 'terra', imageId: 'terra', type: 'planet',
            x: 0, y: 0, scale: 0.25, rotation: 0
        }, preloadedImages);

        const addSystemCenter = (id, imageId, type, scale, spin) => {
            addMapObject({
                id: id, imageId: imageId, type: type,
                x: systemCenters[id].x, y: systemCenters[id].y,
                scale: scale, rotation: 0, rotationSpeed: spin ? (Math.random() - 0.5) * 0.002 : 0
            }, preloadedImages);
        };
        
        // Calculate counts for scaling
        const bblCount = allNfts.filter(n=>n.bbl_market).length;
        const boostCount = allNfts.filter(n=>n.boost_market).length;
        const atriumCount = allNfts.filter(n=>n.atrium_market).length;
        const enterpriseCount = allNfts.filter(n=>n.staked_enterprise_legacy).length;

        addSystemCenter('daodao', 'daodao', 'planet', 0.5, true);
        addSystemCenter('bbl', 'bbl', 'planet', bblCount > 0 ? (bblCount / 59) * 0.5 : 0.1, true); // Use count, default 0.1
        addSystemCenter('boost', 'boost', 'ship_main', 0.5, true); // Fixed size to match other planets
        // ATRIUM NOT ON THE MAP (2026-08-12, deliberate): addSystemCenter needs
        // BOTH a systemCenters['atrium'] coordinate AND a preloaded 'atrium'
        // image; neither exists, and calling it without them throws and takes
        // the whole map view down. Atrium IS counted everywhere else (chips,
        // badges, filters, wallet stats, holder stats, analytics). Adding it
        // here is a design task: pick coordinates that don't collide with the
        // existing systems, and supply the art.
        //   atriumCount is computed above and ready for that work.
        addSystemCenter('enterprise', 'enterprise', 'blackhole', enterpriseCount > 0 ? (enterpriseCount / 515) * 0.5 : 0.1, true);


        const holderStats = {}; // Use allHolderStats if already calculated
        allNfts.forEach(nft => {
            if (nft.owner) {
                if (!holderStats[nft.owner]) {
                    holderStats[nft.owner] = { total: 0, daodaoStaked: 0, bblListed: 0, boostListed: 0, atriumListed: 0, enterpriseStaked: 0 };
                }
                const stats = holderStats[nft.owner];
                stats.total++;
                if (nft.staked_daodao) stats.daodaoStaked++;
                if (nft.bbl_market) stats.bblListed++;
                if (nft.boost_market) stats.boostListed++;
                if (nft.atrium_market) stats.atriumListed++;
                if (nft.staked_enterprise_legacy) stats.enterpriseStaked++;
            }
        });

        const createFleetSystem = (systemId, statKey) => {
            const center = systemCenters[systemId];
            
             const topHolders = Object.entries(holderStats)
                .filter(([, stats]) => stats[statKey] > 0)
                .sort(([, a], [, b]) => b[statKey] - a[statKey])
                .slice(0, 10)
                .map(([address, stats]) => ({ address, ...stats }));
            
            if (topHolders.length === 0) return;

            const countList = topHolders.map(s => s[statKey]);
            const minCount = countList.length > 0 ? Math.min(...countList) : 1;
            const maxCount = countList.length > 0 ? Math.max(...countList) : 1;
            const countRange = maxCount > minCount ? maxCount - minCount : 1;

            const minScale = 0.1; const maxScale = 0.3;
            const scaleRange = maxScale - minScale;
            
            const curW = spaceCanvas.clientWidth, curH = spaceCanvas.clientHeight;
            const minRadius = Math.min(curW, curH) * 0.6;
            const maxRadius = Math.min(curW, curH) * 1.5;
            const radiusRange = maxRadius - minRadius;
            const angleStep = (2 * Math.PI) / topHolders.length;

            topHolders.forEach((stats, index) => {
                const { address, total } = stats;
                const platformCount = stats[statKey];
                const angle = angleStep * index;
                
                const normalizedSize = countRange === 1 ? 0 : (platformCount - minCount) / countRange;
                const distance = minRadius + (normalizedSize * radiusRange);
                const scale = minScale + (normalizedSize * scaleRange);
                const last4 = address.slice(-4);
                
                const mothershipX = center.x + Math.cos(angle) * distance;
                const mothershipY = center.y + Math.sin(angle) * distance;

                addMapObject({
                    id: `mothership_${systemId}_${address}`, imageId: 'allianceLogo', type: 'ship', address: address,
                    system: systemId, lineTargetId: `satellite_${systemId}_${address}`,
                    x: mothershipX, y: mothershipY, scale: scale,
                    textAbove: `${total - platformCount}`, textBelow: last4
                }, preloadedImages);
                
                addMapObject({
                    id: `satellite_${systemId}_${address}`, imageId: 'allianceLogo', type: 'ship', address: address,
                    system: systemId, lineTargetId: systemId,
                    x: (mothershipX + center.x) / 2, y: (mothershipY + center.y) / 2,
                    scale: scale * 0.8, // Satellite slightly smaller
                    textAbove: `${platformCount}`, textBelow: last4
                }, preloadedImages);
            });
        };
        
        const createEnterpriseSystem = () => {
            const center = systemCenters.enterprise;
            const statKey = 'enterpriseStaked';
            
             const topStakers = Object.entries(holderStats)
                .filter(([, stats]) => stats[statKey] > 0)
                .sort(([, a], [, b]) => b[statKey] - a[statKey])
                .slice(0, 10)
                .map(([address, stats]) => ({ address, ...stats }));
            
            if (topStakers.length === 0) return;

            const countList = topStakers.map(s => s[statKey]);
            const minCount = Math.min(...countList);
            const maxCount = Math.max(...countList);
            const countRange = maxCount > minCount ? maxCount - minCount : 1;

            const minScale = 0.1; const maxScale = 0.3;
            const scaleRange = maxScale - minScale;
            
            const curW = spaceCanvas.clientWidth, curH = spaceCanvas.clientHeight;
            const minRadius = Math.min(curW, curH) * 0.6;
            const maxRadius = Math.min(curW, curH) * 1.2;
            const radiusRange = maxRadius - minRadius;
            const angleStep = (2 * Math.PI) / topStakers.length;
            
            topStakers.forEach((stats, index) => {
                const { address, enterpriseStaked } = stats;
                const angle = angleStep * index;
                
                const normalizedSize = countRange === 1 ? 0 : (enterpriseStaked - minCount) / countRange;
                const distance = minRadius + (normalizedSize * radiusRange);
                const scale = minScale + (normalizedSize * scaleRange);
                
                addMapObject({
                    id: `ship_enterprise_${address}`, imageId: 'allianceLogo', type: 'ship', address: address,
                    system: 'enterprise', lineTargetId: 'enterprise',
                    x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance,
                    scale: scale, textAbove: `${enterpriseStaked}`, textBelow: address.slice(-4)
                }, preloadedImages);
            });
        };

        createFleetSystem('daodao', 'daodaoStaked');
        createFleetSystem('bbl', 'bblListed');
        // NOTE: Boost does not get fleet system - just the ship with banner warning
        // createFleetSystem('boost', 'boostListed');
        createEnterpriseSystem();
        console.log("Galaxy built.");
    }

    initMap(); // Call the initializer
};

// --- Reusable Address Search Handler ---
// --- Address Search Direction Toggle ---
const updateDirectionToggle = (toggleBtn, inputEl, isPrefix) => {
    if (!toggleBtn) return;
    if (isPrefix) {
        toggleBtn.textContent = 'Start ⇄';
        toggleBtn.title = 'Mode: Start of address (click to switch to End)';
        inputEl.placeholder = 'Type from start (e.g. terra1x)';
        inputEl.style.textAlign = 'left';
    } else {
        toggleBtn.textContent = 'End ⇄';
        toggleBtn.title = 'Mode: End of address (click to switch to Start)';
        inputEl.placeholder = 'Type from end (last char first)';
        inputEl.style.textAlign = 'right';
    }
};

const setupAddressDirectionToggle = (toggleBtn, inputEl, isWalletSearch) => {
    if (!toggleBtn || !inputEl) return;
    
    // Initialize display
    const isPrefix = isWalletSearch ? walletAddressSearchDirection : addressSearchDirection;
    updateDirectionToggle(toggleBtn, inputEl, isPrefix);
    
    toggleBtn.addEventListener('click', () => {
        if (isWalletSearch) {
            walletAddressSearchDirection = !walletAddressSearchDirection;
            updateDirectionToggle(toggleBtn, inputEl, walletAddressSearchDirection);
        } else {
            addressSearchDirection = !addressSearchDirection;
            updateDirectionToggle(toggleBtn, inputEl, addressSearchDirection);
        }
        // Clear input when switching modes
        inputEl.value = '';
        inputEl.focus();
    });
    
    // Add keydown handler for reverse typing in suffix mode
    inputEl.addEventListener('keydown', (e) => {
        const isPrefix = isWalletSearch ? walletAddressSearchDirection : addressSearchDirection;
        
        // Only intercept in suffix mode (right-to-left)
        if (isPrefix) return;
        
        // Handle backspace - remove from the front
        if (e.key === 'Backspace') {
            e.preventDefault();
            if (inputEl.value.length > 0) {
                inputEl.value = inputEl.value.substring(1); // Remove first character
                // Trigger input event to update suggestions
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return;
        }
        
        // Handle delete - also remove from front
        if (e.key === 'Delete') {
            e.preventDefault();
            if (inputEl.value.length > 0) {
                inputEl.value = inputEl.value.substring(1);
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return;
        }
        
        // Only handle single character keys (letters, numbers)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            // Prepend the new character (reverse typing)
            inputEl.value = e.key + inputEl.value;
            // Trigger input event to update suggestions
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
};

const handleAddressInput = (inputEl, suggestionsEl, onSelectCallback, isWallet) => {
    const isPrefix = isWallet ? walletAddressSearchDirection : addressSearchDirection;
    let input = inputEl.value.toLowerCase().trim();
    
    if (!suggestionsEl) return;
    suggestionsEl.innerHTML = '';

    if (!input) {
        suggestionsEl.classList.add('hidden');
        if (!isWallet && searchAddressInput.value === '' && addressDropdown.value === '') debouncedFilter();
        return;
    }
    
    let matches;
    if (isPrefix) {
        // Left-to-right: user is typing from the beginning (normal)
        matches = ownerAddresses.filter(addr => addr.toLowerCase().startsWith(input));
        matches.sort((a, b) => {
            const charA = a.charAt(input.length) || '';
            const charB = b.charAt(input.length) || '';
            return charA.localeCompare(charB);
        });
    } else {
        // Right-to-left: input is already built in reverse order by keydown handler
        // So input "ulw" means we search for addresses ending in "ulw"
        matches = ownerAddresses.filter(addr => addr.toLowerCase().endsWith(input));
        matches.sort((a, b) => {
            const charA = a.charAt(a.length - input.length - 1) || '';
            const charB = b.charAt(b.length - input.length - 1) || '';
            return charA.localeCompare(charB);
        });
    }

    // Auto-fill if exactly one match
    if (matches.length === 1) {
        inputEl.value = matches[0];
        inputEl.style.textAlign = 'left'; // Show full address left-aligned
        suggestionsEl.classList.add('hidden');
        onSelectCallback();
        return;
    }

    if (matches.length > 0) {
        matches.slice(0, 10).forEach(match => {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item';
            const memberName = getMemberName(match);
            
            // Highlight the matching portion
            let addressHtml;
            if (isPrefix) {
                addressHtml = `<strong class="text-cyan-400">${match.substring(0, input.length)}</strong>${match.substring(input.length)}`;
            } else {
                const startIndex = match.length - input.length;
                addressHtml = `${match.substring(0, startIndex)}<strong class="text-cyan-400">${match.substring(startIndex)}</strong>`;
            }
            
            // Add member name if available
            if (memberName) {
                item.innerHTML = `<span class="text-yellow-400 font-medium">${memberName}</span><br><span class="text-xs">${addressHtml}</span>`;
            } else {
                item.innerHTML = addressHtml;
            }
            
            item.style.direction = 'ltr';
            item.style.textAlign = 'left';
            item.onclick = () => {
                inputEl.value = match;
                inputEl.style.textAlign = 'left'; // Show full address left-aligned
                suggestionsEl.classList.add('hidden');
                onSelectCallback();
            };
            suggestionsEl.appendChild(item);
        });
        
        if (matches.length > 10) {
            const item = document.createElement('div');
            item.className = 'address-suggestion-item text-gray-400';
            item.textContent = `${matches.length - 10} more...`;
            suggestionsEl.appendChild(item);
        }
        suggestionsEl.classList.remove('hidden');
    } else {
        suggestionsEl.classList.add('hidden');
    }
    
    // Trigger filter *only* for collection view input
    if (!isWallet) debouncedFilter();
};

const showWalletExplorerModal = (address) => {
    const walletNfts = allNfts.filter(nft => nft.owner === address);
    if (walletNfts.length === 0) return;

    const titleEl = document.getElementById('wallet-modal-title');
    const statsEl = document.getElementById('wallet-modal-stats');
    const galleryEl = document.getElementById('wallet-modal-gallery');

    if (!titleEl || !statsEl || !galleryEl) return;

    titleEl.textContent = address;
    statsEl.innerHTML = '';
    galleryEl.innerHTML = '';

    const daodaoStaked = walletNfts.filter(n => n.staked_daodao).length;
    const enterpriseStaked = walletNfts.filter(n => n.staked_enterprise_legacy).length;
    const boostListed = walletNfts.filter(n => n.boost_market).length;
    const bblListed = walletNfts.filter(n => n.bbl_market).length;
    const atriumListed = walletNfts.filter(n => n.atrium_market).length;
    const broken = walletNfts.filter(n => n.broken).length;
    const total = walletNfts.length;
    const unbroken = total - broken;
    const liquid = walletNfts.filter(n => n.liquid).length; // Recalculate for this specific wallet

    const stats = [
        { label: 'Total NFTs', value: total, color: 'text-white' },
        { label: 'Liquid', value: liquid, color: 'text-white' },
        { label: 'DAODAO Staked', value: daodaoStaked, color: 'text-cyan-400' },
        { label: 'Enterprise Staked', value: enterpriseStaked, color: 'text-gray-400' },
        { label: 'Boost Listed', value: boostListed, color: 'text-purple-400' },
        { label: 'BBL Listed', value: bblListed, color: 'text-green-400' },
        { label: 'Atrium Listed', value: atriumListed, color: 'text-pink-400' },
        { label: 'Unbroken', value: unbroken, color: 'text-green-400' },
        { label: 'Broken', value: broken, color: 'text-red-400' },
    ];

    stats.forEach(stat => {
        statsEl.innerHTML += `
            <div class="text-center">
                <div class="text-xs text-gray-400 uppercase tracking-wider">${stat.label}</div>
                <div class="text-2xl font-bold ${stat.color}">${stat.value}</div>
            </div>
        `;
    });

    walletNfts.sort((a,b) => (getActiveRank(a) ?? Infinity) - (getActiveRank(b) ?? Infinity)).forEach(nft => {
        galleryEl.appendChild(createNftCard(nft, '.wallet-trait-toggle'));
    });

    walletExplorerModal.classList.remove('hidden');
};

const hideWalletExplorerModal = () => {
    if (walletExplorerModal) walletExplorerModal.classList.add('hidden');
};

// --- System Leaderboard Modal Logic ---
const showSystemLeaderboardModal = (systemId) => {
     const systemKeyMap = {
        daodao: 'daodaoStaked',
        bbl: 'bblListed',
        boost: 'boostListed',
        atrium: 'atriumListed',
        enterprise: 'enterpriseStaked'
    };
    const systemNameMap = {
        daodao: 'DAODAO Staking',
        bbl: 'BackBone Labs Listings',
        boost: 'Boost Marketplace Listings',
        atrium: 'Atrium Marketplace Listings',
        enterprise: 'Enterprise Staking'
    };
    const statKey = systemKeyMap[systemId];
    if (!statKey) return;
    
    const leaderboardData = Object.values(allHolderStats)
        .filter(stats => stats[statKey] > 0)
        .sort((a, b) => b[statKey] - a[statKey]);

    const titleEl = document.getElementById('system-modal-title');
    const disclaimerEl = document.getElementById('system-modal-disclaimer');
    if (!titleEl || !disclaimerEl) return;
    
    titleEl.textContent = `${systemNameMap[systemId]} Leaderboard`;

    if (systemId === 'boost') {
        disclaimerEl.innerHTML = `<strong>Note:</strong> Addresses ending in <strong>...f4at</strong> belong to the Boost contract, not the actual NFT owner. We hope Boost updates their platform in the future to allow for individual owner identification.`;
        disclaimerEl.classList.remove('hidden');
    } else {
        disclaimerEl.classList.add('hidden');
    }
    
    displaySystemLeaderboardPage(leaderboardData, statKey, 1);
    systemLeaderboardModal.classList.remove('hidden');
};

const displaySystemLeaderboardPage = (data, statKey, page) => {
    const tableEl = document.getElementById('system-modal-table');
    const paginationEl = document.getElementById('system-modal-pagination');
    if (!tableEl || !paginationEl) return;
    
    const itemsPerPage = 10;
    tableEl.innerHTML = '';
    paginationEl.innerHTML = '';

    const pageData = data.slice((page - 1) * itemsPerPage, page * itemsPerPage);

    let tableHtml = `<div class="leaderboard-header" style="grid-template-columns: 1fr 4fr 1fr;"><span>Rank</span><span class="text-left">Address</span><span class="text-center">Amount</span></div>`;
    pageData.forEach((stats, index) => {
        const rank = (page - 1) * itemsPerPage + index + 1;
        tableHtml += `
            <div class="leaderboard-row" style="grid-template-columns: 1fr 4fr 1fr;">
                <span class="text-center font-bold">#${rank}</span>
                <span class="font-mono text-sm truncate" title="${stats.address}">${stats.address}</span>
                <span class="text-center font-bold">${stats[statKey] || 0}</span>
            </div>
        `;
    });
    tableEl.innerHTML = tableHtml;

    const totalPages = Math.ceil(data.length / itemsPerPage);
    if (totalPages > 1) {
        const prevBtn = document.createElement('button');
        prevBtn.textContent = 'Previous';
        prevBtn.className = 'pagination-btn';
        prevBtn.disabled = page === 1;
        prevBtn.onclick = () => displaySystemLeaderboardPage(data, statKey, page - 1);
        paginationEl.appendChild(prevBtn);

        const pageInfo = document.createElement('span');
        pageInfo.className = 'text-gray-400';
        pageInfo.textContent = `Page ${page} of ${totalPages}`;
        paginationEl.appendChild(pageInfo);
        
        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next';
        nextBtn.className = 'pagination-btn';
        nextBtn.disabled = page === totalPages;
        nextBtn.onclick = () => displaySystemLeaderboardPage(data, statKey, page + 1);
        paginationEl.appendChild(nextBtn);
    }
};

const hideSystemLeaderboardModal = () => {
    if (systemLeaderboardModal) systemLeaderboardModal.classList.add('hidden');
};

// Show a simple warning banner for Boost ship (no leaderboard)
const showBoostWarningBanner = () => {
    // Create a temporary overlay banner
    const existing = document.getElementById('boost-warning-overlay');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'boost-warning-overlay';
    overlay.className = 'fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4';
    overlay.innerHTML = `
        <div class="bg-gray-800 rounded-lg p-6 max-w-lg w-full border-2 border-purple-500 text-center">
            <div class="text-4xl mb-4">🚀</div>
            <h3 class="text-xl font-bold text-purple-400 mb-3">Boost Marketplace</h3>
            <p class="text-gray-300 mb-4">
                <strong class="text-yellow-400">⚠️ Note:</strong> NFTs listed on Boost are held by the Boost contract 
                (<span class="font-mono text-xs">...f4at</span>), not the original owner's wallet.
            </p>
            <p class="text-gray-400 text-sm mb-4">
                We cannot track individual owners for Boost listings. We hope Boost updates their platform 
                to allow for individual owner identification in the future.
            </p>
            <button id="boost-warning-close" class="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-medium transition-colors">
                Got it!
            </button>
        </div>
    `;
    document.body.appendChild(overlay);
    
    // Close handlers
    const closeBtn = document.getElementById('boost-warning-close');
    if (closeBtn) closeBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
};

const searchWallet = () => {
    if (!walletSearchAddressInput || !walletGallery || !walletGalleryTitle) return;
    
    const address = walletSearchAddressInput.value.trim();
    if (walletAddressSuggestions) walletAddressSuggestions.classList.add('hidden');

    document.querySelectorAll('#leaderboard-table .leaderboard-row').forEach(row => {
        row.classList.toggle('selected', row.dataset.address === address);
    });

    if (!address) {
        showError(walletGallery, 'Please enter a wallet address.');
        walletGalleryTitle.textContent = 'Wallet NFTs';
        return;
    }
    
    // Show loading immediately
    walletGalleryTitle.textContent = 'Loading...';
    walletGallery.innerHTML = '<div class="col-span-full text-center py-8 text-gray-400"><div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400 mb-2"></div><p>Loading wallet NFTs...</p></div>';
    
    // Use setTimeout to allow UI to update before heavy processing
    setTimeout(() => {
        // Get ALL wallet NFTs first
        const allWalletNfts = allNfts.filter(nft => nft.owner === address);
        const totalForWallet = allWalletNfts.length;
        
        // Get filter states with sliders
        const stakedFilter = document.querySelector('.wallet-status-filter[data-status="staked"]');
        const stakedSlider = document.querySelector('.wallet-status-slider[data-slider-status="staked"]');
        const rewardsFilter = document.querySelector('.wallet-status-filter[data-status="rewards"]');
        const rewardsSlider = document.querySelector('.wallet-status-slider[data-slider-status="rewards"]');
        const listedFilter = document.querySelector('.wallet-status-filter[data-status="listed"]');
        const listedSlider = document.querySelector('.wallet-status-slider[data-slider-status="listed"]');
        const liquidFilter = document.querySelector('.wallet-status-filter[data-status="liquid"]');
        const liquidSlider = document.querySelector('.wallet-status-slider[data-slider-status="liquid"]');
        
        const anyFilterActive = stakedFilter?.checked || rewardsFilter?.checked || listedFilter?.checked || liquidFilter?.checked;
        
        let walletNfts;
        
        if (!anyFilterActive) {
            // No filters - show ALL NFTs
            walletNfts = allWalletNfts;
        } else {
            // Filters active - use OR logic (show NFTs matching ANY active filter)
            walletNfts = allWalletNfts.filter(nft => {
                let matchesAny = false;
                
                // Staked: 0=DAO, 1=Both, 2=Enterprise
                if (stakedFilter?.checked) {
                    const val = stakedSlider?.value || '1';
                    if (val === '0' && nft.staked_daodao) matchesAny = true;
                    else if (val === '2' && nft.staked_enterprise_legacy) matchesAny = true;
                    else if (val === '1' && (nft.staked_daodao || nft.staked_enterprise_legacy)) matchesAny = true;
                }
                
                // Rewards: 0=Broken, 1=Both, 2=Unbroken
                if (rewardsFilter?.checked) {
                    const val = rewardsSlider?.value || '1';
                    if (val === '0' && nft.broken === true) matchesAny = true;
                    else if (val === '2' && nft.broken === false) matchesAny = true;
                    else if (val === '1') matchesAny = true; // Both
                }
                
                // Listed on ANY marketplace (registry-driven — Atrium listings
                // were previously invisible to this filter).
                if (listedFilter?.checked) {
                    if (MARKETPLACES.some(m => nft[m.field])) matchesAny = true;
                }
                
                // Liquid: 0=Show liquid, 1=Both, 2=Hide liquid
                if (liquidFilter?.checked) {
                    const val = liquidSlider?.value || '0';
                    if (val === '0' && nft.liquid === true) matchesAny = true;
                    else if (val === '2' && nft.liquid === false) matchesAny = true;
                    else if (val === '1') matchesAny = true; // Both
                }
                
                return matchesAny;
            });
        }
        
        if (anyFilterActive) {
            const memberName = getMemberName(address);
            const shortAddr = `terra...${address.slice(-4)}`;
            const displayName = memberName ? `${memberName} (${shortAddr})` : shortAddr;
            walletGalleryTitle.innerHTML = `Showing ${walletNfts.length} of ${totalForWallet} NFTs for: ${memberName ? `<span class="text-yellow-400">${memberName}</span> <span class="text-gray-400">(${shortAddr})</span>` : shortAddr}`;
        } else {
            const memberName = getMemberName(address);
            const sysLabel = getSystemWalletLabel(address) || (isSystemAddress(address) ? 'DAO / system wallet' : null);
            const shortAddr = `terra...${address.slice(-4)}`;
            if (sysLabel) {
                walletGalleryTitle.innerHTML = `<span class="text-amber-400">${sysLabel}</span> <span class="text-gray-400">(${shortAddr})</span> — ${walletNfts.length} NFTs <span class="text-xs text-gray-500">(not an individual holder)</span>`;
            } else {
                walletGalleryTitle.innerHTML = `Found ${walletNfts.length} NFTs for: ${memberName ? `<span class="text-yellow-400">${memberName}</span> <span class="text-gray-400">(${shortAddr})</span>` : shortAddr}`;
            }
        }
        
        walletGallery.innerHTML = '';
        walletGallery.classList.remove('single-card'); // Reset single card class
        
        if (walletNfts.length === 0) {
            showLoading(walletGallery, anyFilterActive ? 'No NFTs match the selected filters.' : 'No NFTs found for this address.');
            return;
        }
        
        // Add single-card class if only one result for mobile centering
        if (walletNfts.length === 1) {
            walletGallery.classList.add('single-card');
        }
        
        // Sort NFTs
        walletNfts.sort((a,b) => (getActiveRank(a) ?? Infinity) - (getActiveRank(b) ?? Infinity));
        
        // Render cards in batches for better performance
        const batchSize = 20;
        let index = 0;
        
        const renderBatch = () => {
            const fragment = document.createDocumentFragment();
            const end = Math.min(index + batchSize, walletNfts.length);
            
            for (let i = index; i < end; i++) {
                fragment.appendChild(createNftCard(walletNfts[i], '.wallet-trait-toggle'));
            }
            
            walletGallery.appendChild(fragment);
            index = end;
            
            if (index < walletNfts.length) {
                requestAnimationFrame(renderBatch);
            }
        };
        
        renderBatch();
    }, 100); // Delay to let loading indicator show
};

// --- Hash Handling ---
const handleHashChange = () => {
    console.log("Hash changed:", window.location.hash);
    const hash = window.location.hash.substring(1);
    if (hash && /^\d+$/.test(hash)) {
        const nftId = parseInt(hash, 10);
        if (allNfts.length > 0) {
            const nftToShow = allNfts.find(nft => nft.id === nftId);
            if (nftToShow) {
                console.log("Found NFT from hash:", nftId);
                showNftDetails(nftToShow);
            } else {
                console.log("NFT ID from hash not found:", nftId);
                hideNftDetails(); // Hide modal if ID is not valid
            }
        } else if (!isInitialLoad) {
            // Data is loaded, but hash was checked before it was ready.
            // Now we can hide it if it's not found.
             hideNftDetails();
        }
        // If data isn't loaded yet (isInitialLoad = true), do nothing.
        // initializeExplorer will call this function again.
    } else {
        hideNftDetails(); // Hide modal if hash is empty or invalid
    }
};


// --- Initialize Application ---
// Wait for DOM content to be loaded before running the script
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExplorer);
} else {
    initializeExplorer(); // DOM is already ready
}



// --- Snapshot Tool ---
const BBL_COLLECTION_API = 'https://warlock.backbonelabs.io/api/v1/dapps/necropolis/collections/terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const BBL_LISTINGS_API = 'https://warlock.backbonelabs.io/api/v1/dapps/necropolis/nfts?nftContract=terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9&page=1&perPage=100&types=buy_now&sort=price-asc&sisterChains=';

// Snapshot state
let snapshotState = {
    prices: {},
    bbl: {
        collection: null,
        floorUnbroken: null,
        floorBroken: null,
        epochSales: [],
        parsedListings: []
    },
    boost: {
        floorUnbroken: null,
        floorBroken: null,
        epochSales: []
    }
};

const showSnapshotTool = async () => {
    // Reset state
    snapshotState = {
        prices: {},
        bbl: { collection: null, floorUnbroken: null, floorBroken: null, epochSales: [], parsedListings: [] },
        boost: { floorUnbroken: null, floorBroken: null, epochSales: [] }
    };
    
    const existingModal = document.getElementById('snapshot-modal');
    if (existingModal) existingModal.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'snapshot-modal';
    overlay.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 overflow-y-auto';
    overlay.innerHTML = `
        <div class="bg-gray-800 rounded-xl p-6 max-w-4xl w-full border border-gray-600 shadow-2xl my-4 max-h-[95vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-2xl font-bold text-yellow-400">📸 Snapshot Tool</h2>
                <button id="snapshot-close" class="text-gray-400 hover:text-white text-2xl">&times;</button>
            </div>
            <div id="snapshot-content" class="text-gray-300">
                <div class="text-center py-4">
                    <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-400 mb-2"></div>
                    <p>Loading epoch data...</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    
    document.getElementById('snapshot-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    
    const contentDiv = document.getElementById('snapshot-content');
    
    try {
        const epochResponse = await fetch('https://raw.githubusercontent.com/thealliancedao/tla-core/main/docs/epoch_1-300_date.json');
        if (!epochResponse.ok) throw new Error('Failed to fetch epoch data');
        const epochs = await epochResponse.json();
        
        const now = new Date();
        const nowUTC = new Date(now.toISOString());
        
        let currentEpoch = null;
        let epochPosition = '';
        let hoursIntoEpoch = 0;
        
        for (const epoch of epochs) {
            const startTime = new Date(epoch.start_time);
            const endTime = new Date(epoch.end_time);
            
            if (nowUTC >= startTime && nowUTC < endTime) {
                currentEpoch = epoch;
                hoursIntoEpoch = (nowUTC - startTime) / (1000 * 60 * 60);
                
                if (hoursIntoEpoch < 48) epochPosition = 'start';
                else if (hoursIntoEpoch < 120) epochPosition = 'middle';
                else epochPosition = 'end';
                break;
            }
        }
        
        if (!currentEpoch) {
            contentDiv.innerHTML = '<p class="text-red-400">Could not determine current epoch.</p>';
            return;
        }
        
        const nftFilename = `nft-data_${currentEpoch.epoch}_${epochPosition}.json`;
        const bblFilename = `bbl-listings_${currentEpoch.epoch}_${epochPosition}.json`;
        const daysRemaining = ((new Date(currentEpoch.end_time) - nowUTC) / (1000 * 60 * 60 * 24)).toFixed(1);
        
        const stats = {
            total: allNfts.length,
            minted: allNfts.filter(n => !n.owned_by_alliance_dao).length,
            staked_daodao: allNfts.filter(n => n.staked_daodao).length,
            staked_enterprise: allNfts.filter(n => n.staked_enterprise_legacy).length,
            listed_bbl: allNfts.filter(n => n.bbl_market).length,
            listed_boost: allNfts.filter(n => n.boost_market).length,
            listed_atrium: allNfts.filter(n => n.atrium_market).length,
            broken: allNfts.filter(n => n.broken === true).length,
            liquid: allNfts.filter(n => n.liquid === true).length,
            unique_owners: new Set(allNfts.filter(n => !n.owned_by_alliance_dao).map(n => n.owner)).size
        };
        
        contentDiv.innerHTML = `
            <div class="space-y-4">
                <!-- Epoch Info -->
                <div class="bg-gray-700/50 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-cyan-400 mb-2">Current Epoch Info</h3>
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                        <div>Epoch:</div><div class="text-white font-bold">${currentEpoch.epoch}</div>
                        <div>Position:</div><div class="text-white font-bold capitalize">${epochPosition}</div>
                        <div>Hours In:</div><div class="text-white">${hoursIntoEpoch.toFixed(1)}h / 168h</div>
                        <div>Days Left:</div><div class="text-white">${daysRemaining} days</div>
                    </div>
                </div>
                
                <!-- NFT Stats -->
                <div class="bg-gray-700/50 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-cyan-400 mb-2">NFT Status (on-chain)</h3>
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                        <div>Total:</div><div class="text-white">${stats.total.toLocaleString()}</div>
                        <div>Minted:</div><div class="text-white">${stats.minted.toLocaleString()}</div>
                        <div>Staked DAODAO:</div><div class="text-white">${stats.staked_daodao.toLocaleString()}</div>
                        <div>Staked Enterprise:</div><div class="text-white">${stats.staked_enterprise.toLocaleString()}</div>
                        <div>Listed BBL:</div><div class="text-white">${stats.listed_bbl.toLocaleString()}</div>
                        <div>Listed Boost:</div><div class="text-white">${stats.listed_boost.toLocaleString()}</div>
                        <div>Listed Atrium:</div><div class="text-white">${stats.listed_atrium.toLocaleString()}</div>
                        <div>Broken:</div><div class="text-white">${stats.broken.toLocaleString()}</div>
                        <div>Unique Owners:</div><div class="text-white">${stats.unique_owners.toLocaleString()}</div>
                    </div>
                </div>
                
                <!-- Token Prices -->
                <div class="bg-blue-900/30 border border-blue-600 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-blue-400 mb-2">💰 Token Prices (USD)</h3>
                    
                    <div class="mb-3 overflow-x-auto" id="coingecko-widget-container">
                        <gecko-coin-price-static-headline-widget locale="en" dark-mode="true" outlined="true" coin-ids="terra-luna-2,eris-amplified-luna,eris-arbitrage-luna,backbone-labs-staked-luna,solid-2,usd-coin" initial-currency="usd"></gecko-coin-price-static-headline-widget>
                    </div>
                    
                    <button id="extract-prices-btn" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-4 rounded-lg transition-colors text-sm mb-3">
                        🔍 Extract Prices from Widget
                    </button>
                    
                    <div id="extracted-prices-display" class="hidden bg-gray-900 rounded p-3 mb-3 text-sm"></div>
                    
                    <p class="text-xs text-gray-400 mb-2">Manual price entry:</p>
                    <div class="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        <div>
                            <label class="text-xs text-gray-400">LUNA</label>
                            <input type="number" step="0.0001" id="price-luna" placeholder="0.00" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                        </div>
                        <div>
                            <label class="text-xs text-gray-400">ampLUNA</label>
                            <input type="number" step="0.0001" id="price-ampluna" placeholder="0.00" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                        </div>
                        <div>
                            <label class="text-xs text-gray-400">arbLUNA</label>
                            <input type="number" step="0.0001" id="price-arbluna" placeholder="0.00" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                        </div>
                        <div>
                            <label class="text-xs text-gray-400">bLUNA</label>
                            <input type="number" step="0.0001" id="price-bluna" placeholder="0.00" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                        </div>
                        <div>
                            <label class="text-xs text-gray-400">SOLID</label>
                            <input type="number" step="0.0001" id="price-solid" placeholder="0.00" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                        </div>
                        <div>
                            <label class="text-xs text-gray-400">USDC</label>
                            <input type="number" step="0.0001" id="price-usdc" value="1.00" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                        </div>
                    </div>
                </div>
                
                <!-- BBL Marketplace Section -->
                <div class="bg-purple-900/30 border border-purple-600 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-purple-400 mb-3">🦴 BBL Marketplace</h3>
                    
                    <!-- BBL Collection JSON -->
                    <div class="mb-4 bg-gray-800 rounded p-3">
                        <label class="text-sm text-gray-300 block mb-1">Collection Stats JSON:</label>
                        <textarea id="bbl-collection-json" rows="2" placeholder='Paste collection JSON for volume & last sale...' class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono"></textarea>
                        <button id="parse-bbl-collection-btn" class="mt-2 bg-purple-600 hover:bg-purple-500 text-white text-sm py-1 px-3 rounded">Parse Collection</button>
                        <span id="bbl-collection-status" class="ml-2 text-xs text-gray-400"></span>
                        
                        <div id="bbl-collection-results" class="hidden mt-3 p-2 bg-gray-900 rounded text-sm">
                            <div class="grid grid-cols-2 gap-2">
                                <div>All-Time Volume:</div><div id="bbl-alltime-volume" class="text-white">-</div>
                                <div>Most Recent Sale:</div><div id="bbl-recent-sale" class="text-white">-</div>
                            </div>
                            <button id="bbl-add-recent-sale-btn" class="hidden mt-2 bg-green-600 hover:bg-green-500 text-white text-xs py-1 px-3 rounded">
                                ➕ Add Most Recent to Epoch Sales
                            </button>
                        </div>
                    </div>
                    
                    <!-- BBL Listings JSON -->
                    <div class="mb-4 bg-gray-800 rounded p-3">
                        <label class="text-sm text-gray-300 block mb-1">Listings JSON (for floor prices):</label>
                        <textarea id="bbl-listings-json" rows="2" placeholder='Paste listings JSON...' class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs font-mono"></textarea>
                        <button id="parse-bbl-listings-btn" class="mt-2 bg-purple-600 hover:bg-purple-500 text-white text-sm py-1 px-3 rounded">Parse Listings</button>
                        <span id="bbl-listings-status" class="ml-2 text-xs text-gray-400"></span>
                    </div>
                    
                    <!-- BBL Floor Prices -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                        <div class="bg-gray-800 rounded p-3">
                            <h4 class="text-sm font-semibold text-green-400 mb-2">Floor (Unbroken)</h4>
                            <div class="grid grid-cols-3 gap-2 mb-2">
                                <div>
                                    <label class="text-xs text-gray-400">NFT ID</label>
                                    <input type="text" id="bbl-floor-unbroken-id" placeholder="#" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Amount</label>
                                    <input type="number" step="0.01" id="bbl-floor-unbroken-amount" placeholder="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Token</label>
                                    <select id="bbl-floor-unbroken-token" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                        <option value="bLUNA">bLUNA</option>
                                    </select>
                                </div>
                            </div>
                            <div id="bbl-floor-unbroken-usd" class="text-xs text-green-300">= $0.00 USD</div>
                        </div>
                        <div class="bg-gray-800 rounded p-3">
                            <h4 class="text-sm font-semibold text-yellow-400 mb-2">Floor (Broken)</h4>
                            <div class="grid grid-cols-3 gap-2 mb-2">
                                <div>
                                    <label class="text-xs text-gray-400">NFT ID</label>
                                    <input type="text" id="bbl-floor-broken-id" placeholder="#" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Amount</label>
                                    <input type="number" step="0.01" id="bbl-floor-broken-amount" placeholder="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Token</label>
                                    <select id="bbl-floor-broken-token" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                        <option value="bLUNA">bLUNA</option>
                                    </select>
                                </div>
                            </div>
                            <div id="bbl-floor-broken-usd" class="text-xs text-yellow-300">= $0.00 USD</div>
                        </div>
                    </div>
                    
                    <!-- BBL Epoch Sales -->
                    <div class="bg-gray-800 rounded p-3">
                        <h4 class="text-sm font-semibold text-purple-300 mb-2">Epoch Sales</h4>
                        <div class="grid grid-cols-4 gap-2 mb-2">
                            <div>
                                <label class="text-xs text-gray-400">NFT ID</label>
                                <input type="text" id="bbl-sale-id" placeholder="#" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                            </div>
                            <div>
                                <label class="text-xs text-gray-400">Amount</label>
                                <input type="number" step="0.01" id="bbl-sale-amount" placeholder="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                            </div>
                            <div>
                                <label class="text-xs text-gray-400">Token</label>
                                <select id="bbl-sale-token" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                    <option value="bLUNA">bLUNA</option>
                                </select>
                            </div>
                            <div class="flex items-end">
                                <button id="bbl-add-sale-btn" class="w-full bg-purple-600 hover:bg-purple-500 text-white text-xs py-1 px-2 rounded">+ Add</button>
                            </div>
                        </div>
                        <div id="bbl-sales-list" class="text-xs text-gray-300 max-h-32 overflow-y-auto mb-2 space-y-1"></div>
                        <div id="bbl-sales-summary" class="text-sm font-semibold text-purple-300 p-2 bg-purple-900/50 rounded">
                            Epoch Sales: 0 | Volume: 0 bLUNA ($0.00 USD)
                        </div>
                    </div>
                </div>
                
                <!-- Boost Marketplace Section -->
                <div class="bg-orange-900/30 border border-orange-600 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-orange-400 mb-3">🚀 Boost Marketplace</h3>
                    
                    <!-- Boost Floor Prices -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                        <div class="bg-gray-800 rounded p-3">
                            <h4 class="text-sm font-semibold text-green-400 mb-2">Floor (Unbroken)</h4>
                            <div class="grid grid-cols-3 gap-2 mb-2">
                                <div>
                                    <label class="text-xs text-gray-400">NFT ID</label>
                                    <input type="text" id="boost-floor-unbroken-id" placeholder="#" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Amount</label>
                                    <input type="number" step="0.01" id="boost-floor-unbroken-amount" placeholder="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Token</label>
                                    <select id="boost-floor-unbroken-token" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                        <option value="LUNA">LUNA</option>
                                        <option value="ampLUNA">ampLUNA</option>
                                        <option value="arbLUNA">arbLUNA</option>
                                        <option value="bLUNA">bLUNA</option>
                                        <option value="SOLID">SOLID</option>
                                        <option value="USDC">USDC</option>
                                    </select>
                                </div>
                            </div>
                            <div id="boost-floor-unbroken-usd" class="text-xs text-green-300">= $0.00 USD</div>
                        </div>
                        <div class="bg-gray-800 rounded p-3">
                            <h4 class="text-sm font-semibold text-yellow-400 mb-2">Floor (Broken)</h4>
                            <div class="grid grid-cols-3 gap-2 mb-2">
                                <div>
                                    <label class="text-xs text-gray-400">NFT ID</label>
                                    <input type="text" id="boost-floor-broken-id" placeholder="#" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Amount</label>
                                    <input type="number" step="0.01" id="boost-floor-broken-amount" placeholder="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                </div>
                                <div>
                                    <label class="text-xs text-gray-400">Token</label>
                                    <select id="boost-floor-broken-token" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                        <option value="LUNA">LUNA</option>
                                        <option value="ampLUNA">ampLUNA</option>
                                        <option value="arbLUNA">arbLUNA</option>
                                        <option value="bLUNA">bLUNA</option>
                                        <option value="SOLID">SOLID</option>
                                        <option value="USDC">USDC</option>
                                    </select>
                                </div>
                            </div>
                            <div id="boost-floor-broken-usd" class="text-xs text-yellow-300">= $0.00 USD</div>
                        </div>
                    </div>
                    
                    <!-- Boost Epoch Sales -->
                    <div class="bg-gray-800 rounded p-3">
                        <h4 class="text-sm font-semibold text-orange-300 mb-2">Epoch Sales</h4>
                        <div class="grid grid-cols-4 gap-2 mb-2">
                            <div>
                                <label class="text-xs text-gray-400">NFT ID</label>
                                <input type="text" id="boost-sale-id" placeholder="#" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                            </div>
                            <div>
                                <label class="text-xs text-gray-400">Amount</label>
                                <input type="number" step="0.01" id="boost-sale-amount" placeholder="0" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                            </div>
                            <div>
                                <label class="text-xs text-gray-400">Token</label>
                                <select id="boost-sale-token" class="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                                    <option value="LUNA">LUNA</option>
                                    <option value="ampLUNA">ampLUNA</option>
                                    <option value="arbLUNA">arbLUNA</option>
                                    <option value="bLUNA">bLUNA</option>
                                    <option value="SOLID">SOLID</option>
                                    <option value="USDC">USDC</option>
                                </select>
                            </div>
                            <div class="flex items-end">
                                <button id="boost-add-sale-btn" class="w-full bg-orange-600 hover:bg-orange-500 text-white text-xs py-1 px-2 rounded">+ Add</button>
                            </div>
                        </div>
                        <div id="boost-sales-list" class="text-xs text-gray-300 max-h-32 overflow-y-auto mb-2 space-y-1"></div>
                        <div id="boost-sales-summary" class="text-sm font-semibold text-orange-300 p-2 bg-orange-900/50 rounded">
                            Epoch Sales: 0 | Volume: $0.00 USD
                        </div>
                    </div>
                </div>
                
                <!-- Download Section -->
                <div class="bg-yellow-900/30 border border-yellow-600 rounded-lg p-4">
                    <h3 class="text-lg font-semibold text-yellow-400 mb-2">📥 Download Snapshots</h3>
                    <p class="text-sm text-gray-300 mb-3">Epoch ${currentEpoch.epoch} (${epochPosition})</p>
                    
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <button id="snapshot-nft-btn" class="bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2 px-4 rounded-lg transition-colors text-sm">
                            📄 NFT Metadata<br><span class="text-xs opacity-75">${nftFilename}</span>
                        </button>
                        <button id="snapshot-market-btn" class="bg-gradient-to-r from-purple-600 to-orange-600 hover:from-purple-500 hover:to-orange-500 text-white font-bold py-2 px-4 rounded-lg transition-colors text-sm">
                            🛒 Marketplace Data<br><span class="text-xs opacity-75">${bblFilename}</span>
                        </button>
                    </div>
                    
                    <p id="snapshot-status" class="text-center text-sm mt-3 text-gray-400"></p>
                </div>
            </div>
        `;
        
        const downloadState = { nftFilename, bblFilename, currentEpoch, epochPosition };
        
        // --- Helper Functions ---
        const getCurrentPrices = () => ({
            luna: parseFloat(document.getElementById('price-luna').value) || 0,
            ampluna: parseFloat(document.getElementById('price-ampluna').value) || 0,
            arbluna: parseFloat(document.getElementById('price-arbluna').value) || 0,
            bluna: parseFloat(document.getElementById('price-bluna').value) || 0,
            solid: parseFloat(document.getElementById('price-solid').value) || 0,
            usdc: parseFloat(document.getElementById('price-usdc').value) || 1
        });
        
        const toUSD = (amount, token, prices) => {
            if (!amount) return 0;
            const tokenMap = {
                'LUNA': prices.luna,
                'ampLUNA': prices.ampluna,
                'arbLUNA': prices.arbluna,
                'bLUNA': prices.bluna,
                'SOLID': prices.solid,
                'USDC': prices.usdc
            };
            return amount * (tokenMap[token] || 0);
        };
        
        const updateFloorUSD = () => {
            const prices = getCurrentPrices();
            
            // BBL floors
            const bblUnbrokenAmt = parseFloat(document.getElementById('bbl-floor-unbroken-amount').value) || 0;
            const bblUnbrokenToken = document.getElementById('bbl-floor-unbroken-token').value;
            document.getElementById('bbl-floor-unbroken-usd').textContent = `= $${toUSD(bblUnbrokenAmt, bblUnbrokenToken, prices).toFixed(2)} USD`;
            
            const bblBrokenAmt = parseFloat(document.getElementById('bbl-floor-broken-amount').value) || 0;
            const bblBrokenToken = document.getElementById('bbl-floor-broken-token').value;
            document.getElementById('bbl-floor-broken-usd').textContent = `= $${toUSD(bblBrokenAmt, bblBrokenToken, prices).toFixed(2)} USD`;
            
            // Boost floors
            const boostUnbrokenAmt = parseFloat(document.getElementById('boost-floor-unbroken-amount').value) || 0;
            const boostUnbrokenToken = document.getElementById('boost-floor-unbroken-token').value;
            document.getElementById('boost-floor-unbroken-usd').textContent = `= $${toUSD(boostUnbrokenAmt, boostUnbrokenToken, prices).toFixed(2)} USD`;
            
            const boostBrokenAmt = parseFloat(document.getElementById('boost-floor-broken-amount').value) || 0;
            const boostBrokenToken = document.getElementById('boost-floor-broken-token').value;
            document.getElementById('boost-floor-broken-usd').textContent = `= $${toUSD(boostBrokenAmt, boostBrokenToken, prices).toFixed(2)} USD`;
        };
        
        // Add change listeners for live USD updates
        ['bbl-floor-unbroken-amount', 'bbl-floor-broken-amount', 'boost-floor-unbroken-amount', 'boost-floor-broken-amount',
         'bbl-floor-unbroken-token', 'bbl-floor-broken-token', 'boost-floor-unbroken-token', 'boost-floor-broken-token',
         'price-luna', 'price-ampluna', 'price-arbluna', 'price-bluna', 'price-solid', 'price-usdc'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', updateFloorUSD);
            document.getElementById(id)?.addEventListener('change', updateFloorUSD);
        });
        
        const updateBblSalesList = () => {
            const prices = getCurrentPrices();
            const listEl = document.getElementById('bbl-sales-list');
            
            listEl.innerHTML = snapshotState.bbl.epochSales.map((s, i) => {
                const usd = toUSD(s.amount, s.token, prices);
                return `<div class="flex justify-between items-center bg-gray-900 px-2 py-1 rounded">
                    <span>#${s.id}: ${s.amount} ${s.token} ($${usd.toFixed(2)})</span>
                    <button onclick="window.removeBblSale(${i})" class="text-red-400 hover:text-red-300 px-1">×</button>
                </div>`;
            }).join('');
            
            const totalSales = snapshotState.bbl.epochSales.length;
            const totalBLuna = snapshotState.bbl.epochSales.filter(s => s.token === 'bLUNA').reduce((sum, s) => sum + s.amount, 0);
            const totalUSD = snapshotState.bbl.epochSales.reduce((sum, s) => sum + toUSD(s.amount, s.token, prices), 0);
            document.getElementById('bbl-sales-summary').innerHTML = `Epoch Sales: ${totalSales} | Volume: ${totalBLuna.toFixed(2)} bLUNA ($${totalUSD.toFixed(2)} USD)`;
        };
        
        const updateBoostSalesList = () => {
            const prices = getCurrentPrices();
            const listEl = document.getElementById('boost-sales-list');
            
            listEl.innerHTML = snapshotState.boost.epochSales.map((s, i) => {
                const usd = toUSD(s.amount, s.token, prices);
                return `<div class="flex justify-between items-center bg-gray-900 px-2 py-1 rounded">
                    <span>#${s.id}: ${s.amount} ${s.token} ($${usd.toFixed(2)})</span>
                    <button onclick="window.removeBoostSale(${i})" class="text-red-400 hover:text-red-300 px-1">×</button>
                </div>`;
            }).join('');
            
            const totalSales = snapshotState.boost.epochSales.length;
            const totalUSD = snapshotState.boost.epochSales.reduce((sum, s) => sum + toUSD(s.amount, s.token, prices), 0);
            document.getElementById('boost-sales-summary').innerHTML = `Epoch Sales: ${totalSales} | Volume: $${totalUSD.toFixed(2)} USD`;
        };
        
        window.removeBblSale = (i) => { snapshotState.bbl.epochSales.splice(i, 1); updateBblSalesList(); };
        window.removeBoostSale = (i) => { snapshotState.boost.epochSales.splice(i, 1); updateBoostSalesList(); };
        
        // --- Event Handlers ---
        
        // Extract prices - improved parsing
        document.getElementById('extract-prices-btn').onclick = () => {
            const displayEl = document.getElementById('extracted-prices-display');
            const widgetContainer = document.getElementById('coingecko-widget-container');
            const widgetText = widgetContainer?.innerText || '';
            
            console.log('Widget text:', widgetText); // Debug
            
            // More flexible price extraction
            const prices = { luna: null, ampluna: null, arbluna: null, bluna: null, solid: null, usdc: null };
            
            // Try multiple patterns for each token
            const patterns = [
                { key: 'luna', patterns: [/Terra\s*\$([0-9.]+)/i, /LUNA\s*\$([0-9.]+)/i, /\$([0-9.]+)\s*Terra/i] },
                { key: 'ampluna', patterns: [/ampLUNA\s*\$([0-9.]+)/i, /Amplified\s*\$([0-9.]+)/i, /Eris Amplified[^$]*\$([0-9.]+)/i] },
                { key: 'arbluna', patterns: [/arbLUNA\s*\$([0-9.]+)/i, /Arbitrage\s*\$([0-9.]+)/i, /Eris Arbitrage[^$]*\$([0-9.]+)/i] },
                { key: 'bluna', patterns: [/bLUNA\s*\$([0-9.]+)/i, /Staked LUNA\s*\$([0-9.]+)/i, /Backbone[^$]*\$([0-9.]+)/i] },
                { key: 'solid', patterns: [/SOLID\s*\$([0-9.]+)/i, /Solid\s*\$([0-9.]+)/i] },
                { key: 'usdc', patterns: [/USDC\s*\$([0-9.]+)/i, /USD Coin\s*\$([0-9.]+)/i] }
            ];
            
            for (const token of patterns) {
                for (const pattern of token.patterns) {
                    const match = widgetText.match(pattern);
                    if (match) {
                        prices[token.key] = parseFloat(match[1]);
                        break;
                    }
                }
            }
            
            // Fill inputs
            if (prices.luna) document.getElementById('price-luna').value = prices.luna;
            if (prices.ampluna) document.getElementById('price-ampluna').value = prices.ampluna;
            if (prices.arbluna) document.getElementById('price-arbluna').value = prices.arbluna;
            if (prices.bluna) document.getElementById('price-bluna').value = prices.bluna;
            if (prices.solid) document.getElementById('price-solid').value = prices.solid;
            if (prices.usdc) document.getElementById('price-usdc').value = prices.usdc;
            
            snapshotState.prices = prices;
            updateFloorUSD();
            
            const found = Object.entries(prices).filter(([k,v]) => v).map(([k,v]) => `${k.toUpperCase()}: $${v}`);
            if (found.length > 0) {
                displayEl.innerHTML = `<span class="text-green-400">✅ Extracted:</span> ${found.join(' | ')}`;
            } else {
                displayEl.innerHTML = `<span class="text-yellow-400">⚠️ Could not auto-extract. Please enter prices manually from the widget above.</span>`;
            }
            displayEl.classList.remove('hidden');
        };
        
        // Parse BBL Collection
        document.getElementById('parse-bbl-collection-btn').onclick = () => {
            const json = document.getElementById('bbl-collection-json').value.trim();
            const statusEl = document.getElementById('bbl-collection-status');
            const resultsEl = document.getElementById('bbl-collection-results');
            
            if (!json) { statusEl.textContent = '⚠️ No JSON'; return; }
            
            try {
                const data = JSON.parse(json);
                snapshotState.bbl.collection = data;
                
                const prices = getCurrentPrices();
                const volumeUSD = data.volume && prices.bluna ? (data.volume * prices.bluna).toFixed(2) : '?';
                
                document.getElementById('bbl-alltime-volume').innerHTML = `${data.volume?.toLocaleString() || '?'} bLUNA ($${volumeUSD} USD)`;
                document.getElementById('bbl-recent-sale').innerHTML = `#${data.last_sale_token_id || '?'} for ${data.last_sale_amount || '?'} bLUNA`;
                
                resultsEl.classList.remove('hidden');
                
                // Show add button if there's a recent sale
                if (data.last_sale_token_id && data.last_sale_amount) {
                    const addBtn = document.getElementById('bbl-add-recent-sale-btn');
                    addBtn.classList.remove('hidden');
                    addBtn.onclick = () => {
                        snapshotState.bbl.epochSales.push({
                            id: data.last_sale_token_id,
                            amount: data.last_sale_amount,
                            token: 'bLUNA'
                        });
                        updateBblSalesList();
                        addBtn.textContent = '✅ Added!';
                        addBtn.disabled = true;
                    };
                }
                
                statusEl.textContent = '✅ Parsed!';
                statusEl.className = 'ml-2 text-xs text-green-400';
            } catch (e) {
                statusEl.textContent = `❌ ${e.message}`;
                statusEl.className = 'ml-2 text-xs text-red-400';
            }
        };
        
        // Parse BBL Listings
        document.getElementById('parse-bbl-listings-btn').onclick = () => {
            const json = document.getElementById('bbl-listings-json').value.trim();
            const statusEl = document.getElementById('bbl-listings-status');
            
            if (!json) { statusEl.textContent = '⚠️ No JSON'; return; }
            
            try {
                const data = JSON.parse(json);
                let floorBroken = null, floorUnbroken = null;
                let floorBrokenId = null, floorUnbrokenId = null;
                
                if (data.nfts) {
                    snapshotState.bbl.parsedListings = data.nfts;
                    
                    for (const nft of data.nfts) {
                        const price = nft.auction?.reserve_price ? nft.auction.reserve_price / 1000000 : null;
                        const isBroken = nft.special_trait === 'BROKEN';
                        
                        if (price) {
                            if (isBroken && (floorBroken === null || price < floorBroken)) {
                                floorBroken = price;
                                floorBrokenId = nft.nft_token_id;
                            }
                            if (!isBroken && (floorUnbroken === null || price < floorUnbroken)) {
                                floorUnbroken = price;
                                floorUnbrokenId = nft.nft_token_id;
                            }
                        }
                    }
                    
                    if (floorUnbroken !== null) {
                        document.getElementById('bbl-floor-unbroken-id').value = floorUnbrokenId;
                        document.getElementById('bbl-floor-unbroken-amount').value = floorUnbroken;
                    }
                    if (floorBroken !== null) {
                        document.getElementById('bbl-floor-broken-id').value = floorBrokenId;
                        document.getElementById('bbl-floor-broken-amount').value = floorBroken;
                    }
                    
                    updateFloorUSD();
                    statusEl.textContent = `✅ ${data.nfts.length} listings. Floors filled!`;
                    statusEl.className = 'ml-2 text-xs text-green-400';
                }
            } catch (e) {
                statusEl.textContent = `❌ ${e.message}`;
                statusEl.className = 'ml-2 text-xs text-red-400';
            }
        };
        
        // Add BBL Sale
        document.getElementById('bbl-add-sale-btn').onclick = () => {
            const id = document.getElementById('bbl-sale-id').value.trim();
            const amount = parseFloat(document.getElementById('bbl-sale-amount').value) || 0;
            const token = document.getElementById('bbl-sale-token').value;
            
            if (!id || !amount) return;
            
            snapshotState.bbl.epochSales.push({ id, amount, token });
            document.getElementById('bbl-sale-id').value = '';
            document.getElementById('bbl-sale-amount').value = '';
            updateBblSalesList();
        };
        
        // Add Boost Sale
        document.getElementById('boost-add-sale-btn').onclick = () => {
            const id = document.getElementById('boost-sale-id').value.trim();
            const amount = parseFloat(document.getElementById('boost-sale-amount').value) || 0;
            const token = document.getElementById('boost-sale-token').value;
            
            if (!id || !amount) return;
            
            snapshotState.boost.epochSales.push({ id, amount, token });
            document.getElementById('boost-sale-id').value = '';
            document.getElementById('boost-sale-amount').value = '';
            updateBoostSalesList();
        };
        
        // NFT Download
        document.getElementById('snapshot-nft-btn').onclick = async () => {
            const btn = document.getElementById('snapshot-nft-btn');
            const statusEl = document.getElementById('snapshot-status');
            
            btn.disabled = true;
            statusEl.textContent = 'Downloading from chain-of-truth pipeline...';
            
            try {
                const response = await fetch(STATUS_DATA_URL);
                if (!response.ok) throw new Error('Failed to fetch');
                const data = await response.json();
                
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = downloadState.nftFilename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                btn.innerHTML = `✅ Downloaded!<br><span class="text-xs opacity-75">${downloadState.nftFilename}</span>`;
                statusEl.textContent = `Saved ${downloadState.nftFilename}`;
                statusEl.className = 'text-center text-sm mt-3 text-green-400';
            } catch (e) {
                btn.disabled = false;
                statusEl.textContent = `Error: ${e.message}`;
                statusEl.className = 'text-center text-sm mt-3 text-red-400';
            }
        };
        
        // Marketplace Download
        document.getElementById('snapshot-market-btn').onclick = () => {
            const prices = getCurrentPrices();
            
            // Gather floor data with USD
            const getFloorData = (prefix) => {
                const id = document.getElementById(`${prefix}-id`).value || null;
                const amount = parseFloat(document.getElementById(`${prefix}-amount`).value) || null;
                const token = document.getElementById(`${prefix}-token`).value;
                const usd = amount ? toUSD(amount, token, prices) : null;
                return { nft_id: id, amount, token, usd: usd ? parseFloat(usd.toFixed(2)) : null };
            };
            
            // Calculate volumes with USD
            const bblSalesWithUSD = snapshotState.bbl.epochSales.map(s => ({
                ...s,
                usd: parseFloat(toUSD(s.amount, s.token, prices).toFixed(2))
            }));
            const boostSalesWithUSD = snapshotState.boost.epochSales.map(s => ({
                ...s,
                usd: parseFloat(toUSD(s.amount, s.token, prices).toFixed(2))
            }));
            
            const bblVolumeBLuna = bblSalesWithUSD.filter(s => s.token === 'bLUNA').reduce((sum, s) => sum + s.amount, 0);
            const bblVolumeUSD = bblSalesWithUSD.reduce((sum, s) => sum + s.usd, 0);
            const boostVolumeUSD = boostSalesWithUSD.reduce((sum, s) => sum + s.usd, 0);
            
            const snapshot = {
                snapshot_time: new Date().toISOString(),
                epoch: downloadState.currentEpoch.epoch,
                epoch_position: downloadState.epochPosition,
                prices_at_snapshot: {
                    luna_usd: prices.luna || null,
                    ampluna_usd: prices.ampluna || null,
                    arbluna_usd: prices.arbluna || null,
                    bluna_usd: prices.bluna || null,
                    solid_usd: prices.solid || null,
                    usdc_usd: prices.usdc || null
                },
                bbl_marketplace: {
                    all_time_volume_bluna: snapshotState.bbl.collection?.volume || null,
                    all_time_volume_usd: snapshotState.bbl.collection?.volume && prices.bluna 
                        ? parseFloat((snapshotState.bbl.collection.volume * prices.bluna).toFixed(2)) 
                        : null,
                    most_recent_sale: snapshotState.bbl.collection ? {
                        nft_id: snapshotState.bbl.collection.last_sale_token_id,
                        amount: snapshotState.bbl.collection.last_sale_amount,
                        token: 'bLUNA',
                        auction_id: snapshotState.bbl.collection.last_sale_auction_id
                    } : null,
                    floor_unbroken: getFloorData('bbl-floor-unbroken'),
                    floor_broken: getFloorData('bbl-floor-broken'),
                    epoch_sales: bblSalesWithUSD,
                    epoch_sales_count: bblSalesWithUSD.length,
                    epoch_volume_bluna: parseFloat(bblVolumeBLuna.toFixed(2)),
                    epoch_volume_usd: parseFloat(bblVolumeUSD.toFixed(2)),
                    total_listings: snapshotState.bbl.parsedListings.length
                },
                boost_marketplace: {
                    floor_unbroken: getFloorData('boost-floor-unbroken'),
                    floor_broken: getFloorData('boost-floor-broken'),
                    epoch_sales: boostSalesWithUSD,
                    epoch_sales_count: boostSalesWithUSD.length,
                    epoch_volume_usd: parseFloat(boostVolumeUSD.toFixed(2))
                },
                combined_epoch_volume_usd: parseFloat((bblVolumeUSD + boostVolumeUSD).toFixed(2))
            };
            
            const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadState.bblFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            const btn = document.getElementById('snapshot-market-btn');
            const statusEl = document.getElementById('snapshot-status');
            btn.innerHTML = `✅ Downloaded!<br><span class="text-xs opacity-75">${downloadState.bblFilename}</span>`;
            statusEl.textContent = `Saved ${downloadState.bblFilename}`;
            statusEl.className = 'text-center text-sm mt-3 text-green-400';
        };
        
    } catch (error) {
        console.error('Snapshot error:', error);
        contentDiv.innerHTML = `<p class="text-red-400">Error: ${error.message}</p>`;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const snapshotBtn = document.getElementById('snapshot-tool-btn');
    if (snapshotBtn) snapshotBtn.addEventListener('click', showSnapshotTool);
});
