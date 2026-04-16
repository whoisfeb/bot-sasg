require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ==========================================
// --- KONFIGURASI CHANNEL & TOKEN ---
// ==========================================
const TOKEN = process.env.DISCORD_BOT_TOKEN; 
const PROMOTION_CHANNEL_ID = process.env.DISCORD_PROMOTION_CHANNEL_ID || '1444904948692422756';
const NOTIF_CHANNEL_ID = '1493137414175326249'; 

// ==========================================
// --- ROLE IDENTITAS UTAMA (WAJIB BENAR) ---
// ==========================================
const WARGA_ROLE_ID = '1444908142587547658';       // Role: Warga Excellence
const POLICE_MAIN_ROLE_ID = '1444908462067945623'; // Role: Excellence Police

// ==========================================
// --- 1. MAPPING PREFIX NICKNAME ---
// ==========================================
const rankPrefixes = {
    '1444909938001580257': 'COP',
    '1444909771181522974': 'ACOP',
    '1444909625475596349': 'DCOP',
    '1444908730230771723': 'COM',
    '1444918644600606770': 'CAPT III',
    '1444918698484826173': 'CAPT II',
    '1444918744815112302': 'CAPT I',
    '1444918819717124186': 'LT III',
    '1444918867691569244': 'LT II',
    '1444918922766843904': 'LT I',
    '1444919014139756685': 'SGT III',
    '1444919052815564910': 'SGT II',
    '1444919550981308426': 'SGT I',
    '1444919660054188032': 'DET III',
    '1444919733114896465': 'DET II',
    '1444919777553420339': 'DET I',
    '1444919938891649145': 'PO III',
    '1444920044239982673': 'PO II',
    '1444920144793964595': 'PO I',
    '1444920482578173953': 'CADET',
};

// ==========================================
// --- 2. MAPPING ROLE KELOMPOK (GROUPS) ---
// ==========================================
const groupRoles = {
    '1444919938891649145': '1444918351037206570', // Group: Police Officer
    '1444920044239982673': '1444918351037206570',
    '1444920144793964595': '1444918351037206570',
    '1444919660054188032': '1444918302508843139', // Group: Detective
    '1444919733114896465': '1444918302508843139',
    '1444919777553420339': '1444918302508843139',
    '1444919014139756685': '1469596428706910292', // Group: Supervisor
    '1444919052815564910': '1469596428706910292',
    '1444919550981308426': '1469596428706910292',
    '1444918819717124186': '1444910648516415488', // Group: Command Team
    '1444918867691569244': '1444910648516415488',
    '1444918922766843904': '1444910648516415488',
    '1444918644600606770': '1444910648516415488',
    '1444918698484826173': '1444910648516415488',
    '1444918744815112302': '1444910648516415488',
    '1444908730230771723': '1444910578266148897', // Group: High Command
    '1444909625475596349': '1444910578266148897',
    '1444909771181522974': '1444910578266148897',
    '1444909938001580257': '1444910578266148897',
};

// ==========================================
// --- 3. DAFTAR MEMBERSIHKAN ROLE POLISI ---
// ==========================================
const allGroupIDs = [
    POLICE_MAIN_ROLE_ID,    // Excellence Police
    '1444918351037206570', // Group: Police Officer
    '1444918302508843139', // Group: Detective
    '1469596428706910292', // Group: Supervisor
    '1444910648516415488', // Group: Command Team
    '1444910578266148897',
    '1444921188215165141',  // Group: HIGHWAY PATROL
    '1444920955620032533', // Group: RAMPART
    '1444920880370159617', // Group: MERTOPOLITAN
    '1444921352120434819', // Group: IAD
    '1444908272363769887', // Group: HRB
];

client.once('ready', () => {
    console.log(`Bot login sebagai ${client.user.tag}`);
    const notifChannel = client.channels.cache.get(NOTIF_CHANNEL_ID);
    if (notifChannel) {
        notifChannel.send(`✅ **Sistem SAPD Online** | ${new Date().toLocaleString('id-ID')} | Status: Menunggu Promosi/Demotion... \n\n*Bot ini akan otomatis memproses promosi/demotion berdasarkan format yang ditentukan di channel promosi.*\n*Pastikan format benar agar bot dapat memproses dengan lancar.*\n*Ketika tidak ada aktivitas yang sesuai format di channel <#1444904948692422756> maka bot akan offline.*\n@everyone`)
        .catch(console.error);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || message.channel.id !== PROMOTION_CHANNEL_ID) return;

    const isPromotion = message.content.includes('**PROMOTION**');
    const isDemotion = message.content.includes('**DEMOTION**');

    if (isPromotion || isDemotion) {
        const nameLine = message.content.match(/Name:\s*(.*)/i);
        const userMatches = nameLine ? nameLine[1].match(/<@!?(\d+)>/g) : null;
        const prevRankMatch = message.content.match(/Previous Rank:\s*<@&(\d+)>/i);
        const newRankMatch = message.content.match(/Rank to be (?:promoted|demoted):\s*<@&(\d+)>/i);
        
        const prevDivLine = message.content.match(/Previous Division\s*:\s*(.*)/i);
        const prevDivs = prevDivLine ? prevDivLine[1].match(/<@&(\d+)>/g) : null;
        
        const newDivLine = message.content.match(/(?:Moved to this division|Moved to this\s+division)\s*:?\s*(.*)/i);
        const newDivs = newDivLine ? newDivLine[1].match(/<@&(\d+)>/g) : null;

        if (!userMatches) return;

        for (const mention of userMatches) {
            const userID = mention.replace(/[<@!>]/g, '');
            try {
                const member = await message.guild.members.fetch(userID);
                const botMember = message.guild.members.me;

                // PROTEKSI HIERARKI: Bot tidak bisa ubah member yang rolenya lebih tinggi dari bot
                if (member.roles.highest.position >= botMember.roles.highest.position) {
                    console.warn(`[SKIP] Role ${member.user.tag} terlalu tinggi untuk Bot.`);
                    continue;
                }

                const newRankID = newRankMatch ? newRankMatch[1] : null;

                // --- PROSES KELUAR POLISI (DEMOTE KE WARGA) ---
                if (newRankID === WARGA_ROLE_ID) {
                    // 1. Cabut Pangkat Terakhir
                    if (prevRankMatch) await member.roles.remove(prevRankMatch[1]).catch(() => null);
                    
                    // 2. Cabut Semua Role Kelompok (Termasuk Excellence Police)
                    for (const groupID of allGroupIDs) {
                        if (member.roles.cache.has(groupID)) {
                            await member.roles.remove(groupID).catch(e => console.error(`Gagal cabut group ${groupID}: ${e.message}`));
                        }
                    }

                    // 3. Cabut Divisi
                    if (prevDivs) {
                        for (const div of prevDivs) await member.roles.remove(div.replace(/[<@&>]/g, '')).catch(() => null);
                    }

                    // 4. Tambah Warga Excellence & Reset Nickname ke Civil
                    await member.roles.add(WARGA_ROLE_ID).catch(console.error);
                    
                    let cleanName = member.displayName;
                    if (cleanName.includes('|')) cleanName = cleanName.split('|')[1].trim();
                    const newNickname = `Civil | ${cleanName}`.substring(0, 32);
                    await member.setNickname(newNickname).catch(() => null);
                } 
                // --- PROSES POLISI NORMAL (PROMOSI/DEMOSI PANGKAT) ---
                else {
                    if (prevRankMatch) await member.roles.remove(prevRankMatch[1]).catch(() => null);
                    if (newRankID) await member.roles.add(newRankID).catch(console.error);

                    if (prevDivs) {
                        for (const div of prevDivs) await member.roles.remove(div.replace(/[<@&>]/g, '')).catch(() => null);
                    }
                    if (newDivs) {
                        for (const div of newDivs) await member.roles.add(div.replace(/[<@&>]/g, '')).catch(console.error);
                    }

                    // Sinkronisasi Role Kelompok
                    if (newRankID && groupRoles[newRankID]) {
                        const targetGroupID = groupRoles[newRankID];
                        for (const groupID of allGroupIDs) {
                            // Jangan cabut Role Inti (Excellence Police) saat update pangkat biasa
                            if (member.roles.cache.has(groupID) && groupID !== targetGroupID && groupID !== POLICE_MAIN_ROLE_ID) {
                                await member.roles.remove(groupID).catch(() => null);
                            }
                        }
                        await member.roles.add(targetGroupID).catch(console.error);
                    }

                    // Update Prefix Nickname
                    if (newRankID && rankPrefixes[newRankID]) {
                        const prefix = rankPrefixes[newRankID];
                        let cleanName = member.displayName;
                        if (cleanName.includes('|')) cleanName = cleanName.split('|')[1].trim();
                        const newNickname = `${prefix} | ${cleanName}`.substring(0, 32);
                        await member.setNickname(newNickname).catch(() => null);
                    }
                }
                console.log(`Berhasil memproses ${member.user.tag}`);
            } catch (error) {
                console.error(`Gagal memproses ID ${userID}:`, error);
            }
        }
        await message.react('✅');
    }
});

async function sendOfflineNotif() {
    const notifChannel = client.channels.cache.get(NOTIF_CHANNEL_ID);
    if (notifChannel) {
        try {
            await notifChannel.send(`⚠️ **Sistem SAPD Offline**\n\n*Silahkan tunggu sistem SAPD online kembali\n\n@everyone | ${new Date().toLocaleString('id-ID')} | Status: Berhenti/Timeout. \n*Bot akan aktif kembali otomatis sesuai jadwal atau jika dijalankan manual.*`);
        } catch (err) {
            console.error("Gagal mengirim pesan offline:", err);
        }
    }
}

process.on('SIGTERM', async () => {
    await sendOfflineNotif();
    process.exit(0);
});

process.on('SIGINT', async () => {
    await sendOfflineNotif();
    process.exit(0);
});

client.login(TOKEN);
