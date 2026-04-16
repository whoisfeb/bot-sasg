require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ChannelType, 
    Partials 
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// --- KONFIGURASI SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- INISIALISASI CLIENT DISCORD ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// --- DAFTAR ID (KONFIGURASI) ---
const ANNOUNCEMENT_CHANNEL_ID = "1492401243476197376"; 
const FORUM_CHANNEL_ID = "1494352421294444595"; 
const STORAGE_BUCKET_NAME = "bukti-absen"; 
const REQUIRED_ROLE_ID = "1492398964610170940"; 
const ADMIN_ROLE_ID = "1492400977012068363"; 
const DISCORD_GUILD_ID = "1391854057487863998";

// --- MAPPING PANGKAT ---
const PANGKAT_MAP = {
    "1391976318366650410": "GUBERUR",
    "1391976320266801343": "WAKIL GUBERNUR",
    "1391976322154365018": "SEKRETARIS",
    "1391976325958471710": "KEPALA DIVISI",
    "1391976330014232597": "STAFF SENIOR",
    "1492398501685104740": "STAFF JUNIOR",
    "1492398633679585393": "STAFF MAGANG"
};

// --- MAPPING DIVISI ---
const DIVISI_MAP = {
    "1444921188215165141": "HIGHWAY PATROL",
    "1444920955620032533": "RAMPART DIVISION",
    "1444920880370159617": "METROPOLITAN",
    "1444908272363769887": "HUMAN RESOURCE BUREAU",
    "1444921352120434819": "INTERNAL AFFAIRS DIVISION"
};

// --- CACHE UNTUK MEMBER ---
let memberCache = {
    data: null,
    expiry: 0
};

// --- FUNGSI RETRY DENGAN EXPONENTIAL BACKOFF ---
async function withRetry(fn, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            // Jika rate limited, tunggu lebih lama
            if (error.status === 429 || error.message?.includes('rate')) {
                const delay = (error.retry_after || initialDelay) * Math.pow(2, i);
                console.warn(`[RATE LIMIT] Menunggu ${delay}ms sebelum retry ke-${i + 1}...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else if (i < maxRetries - 1) {
                // Jika error lain, coba lagi dengan backoff
                const delay = initialDelay * Math.pow(2, i);
                console.warn(`[RETRY ${i + 1}/${maxRetries}] Error: ${error.message}. Menunggu ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    
    throw lastError;
}

// --- FUNGSI VALIDASI URL ---
function isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    url = url.trim();
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
}

// --- FUNGSI CACHE MEMBERS ---
async function getMembersSafe(guild) {
    const now = Date.now();
    
    // Gunakan cache jika masih fresh (5 menit)
    if (memberCache.data && memberCache.expiry > now) {
        console.log("[CACHE] Menggunakan member cache (masih valid)...");
        return memberCache.data;
    }

    try {
        console.log("[FETCH] Mengambil data members baru dari Discord...");
        const members = await withRetry(async () => {
            return await guild.members.fetch();
        }, 3, 1000);

        memberCache.data = members;
        memberCache.expiry = now + (5 * 60 * 1000); // 5 menit

        console.log(`[CACHE] Cache updated dengan ${members.size} members`);
        return members;
    } catch (err) {
        console.error("[ERROR] Gagal fetch members:", err.message);
        
        // Return cached data jika ada, meski sudah expired
        if (memberCache.data) {
            console.log("[FALLBACK] Menggunakan cached data sebagai fallback...");
            return memberCache.data;
        }
        
        return new Map();
    }
}

// --- FUNGSI CLEANUP USER TANPA REQUIRED ROLE ---
async function cleanupUsersWithoutRole(guild) {
    console.log("\n[CLEANUP-1] ========== MULAI CLEANUP USER ==========");
    
    try {
        const { data: allUsersInDb, error: fetchErr } = await supabase
            .from('users_master')
            .select('discord_id');

        if (fetchErr) {
            console.error("[DB ERROR] Gagal fetch users_master:", fetchErr.message);
            return;
        }

        if (!allUsersInDb || allUsersInDb.length === 0) {
            console.log("[CLEANUP-1] users_master kosong.");
            return;
        }

        console.log(`[CLEANUP-1] Ditemukan ${allUsersInDb.length} user di database`);

        let cleanupCount = 0;

        for (const userRecord of allUsersInDb) {
            const discordId = userRecord.discord_id;
            
            try {
                // ✅ PERBAIKAN: Gunakan retry wrapper dengan null check yang lebih baik
                const member = await withRetry(async () => {
                    return await guild.members.fetch(discordId).catch(() => null);
                }, 3, 500);
                
                // ✅ PERBAIKAN: Proper null checking dengan optional chaining
                const hasRequiredRole = member?.roles?.cache?.has(REQUIRED_ROLE_ID) ?? false;
                
                if (!member || !hasRequiredRole) {
                    console.log(`[CLEANUP-1] User ${discordId} tidak valid, menghapus...`);

                    // 2A. HAPUS GAMBAR BUKTI DARI STORAGE
                    const { data: absenRecords, error: absenErr } = await supabase
                        .from('absensi_sasg')
                        .select('id, bukti_foto')
                        .eq('discord_id', discordId);

                    if (!absenErr && absenRecords && absenRecords.length > 0) {
                        for (const record of absenRecords) {
                            if (record.bukti_foto && isValidUrl(record.bukti_foto)) {
                                try {
                                    const namaFile = record.bukti_foto.split('/').pop();
                                    const pathLengkap = `absensi/${namaFile}`;
                                    
                                    await withRetry(async () => {
                                        return await supabase.storage
                                            .from(STORAGE_BUCKET_NAME)
                                            .remove([pathLengkap]);
                                    }, 2, 500);
                                    
                                    console.log(`  ✓ Gambar dihapus: ${namaFile}`);
                                } catch (imgErr) {
                                    console.warn(`  ⚠ Error hapus gambar:`, imgErr.message);
                                }
                            }
                        }
                    }

                    // 2B. HAPUS SEMUA DATA ABSENSI USER
                    const { error: delAbsenErr } = await supabase
                        .from('absensi_sasg')
                        .delete()
                        .eq('discord_id', discordId);

                    if (!delAbsenErr) {
                        console.log(`  ✓ Data absensi dihapus`);
                    } else {
                        console.warn(`  ⚠ Gagal hapus absensi: ${delAbsenErr.message}`);
                    }

                    // 2C. HAPUS USER DARI users_master
                    const { error: delUserErr } = await supabase
                        .from('users_master')
                        .delete()
                        .eq('discord_id', discordId);

                    if (!delUserErr) {
                        console.log(`  ✓ User ${discordId} dihapus dari users_master`);
                        cleanupCount++;
                    } else {
                        console.warn(`  ⚠ Gagal hapus user: ${delUserErr.message}`);
                    }
                }
            } catch (err) {
                console.error(`  ✗ Error cleanup user ${discordId}:`, err.message);
            }

            // ✅ PERBAIKAN: Naikkan delay dari 300ms → 800ms
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        console.log(`[CLEANUP-1] ========== SELESAI (${cleanupCount} user dihapus) ==========\n`);
    } catch (errGlobal) {
        console.error("[CRITICAL ERROR] cleanupUsersWithoutRole:", errGlobal.message);
    }
}

// --- FUNGSI CLEANUP ABSENSI ORPHANED ---
async function cleanupOrphanedAbsences(guild) {
    console.log("\n[CLEANUP-2] ========== MULAI CLEANUP ABSENSI ORPHANED ==========");
    
    try {
        const { data: validUsers, error: fetchValidErr } = await supabase
            .from('users_master')
            .select('discord_id');

        if (fetchValidErr) {
            console.error("[DB ERROR] Gagal fetch users_master:", fetchValidErr.message);
            return;
        }

        const validUserIds = validUsers ? validUsers.map(u => u.discord_id) : [];

        const { data: allAbsences, error: fetchAbsenErr } = await supabase
            .from('absensi_sasg')
            .select('id, discord_id, bukti_foto');

        if (fetchAbsenErr) {
            console.error("[DB ERROR] Gagal fetch absensi_sasg:", fetchAbsenErr.message);
            return;
        }

        if (!allAbsences || allAbsences.length === 0) {
            console.log("[CLEANUP-2] Tidak ada data absensi.");
            return;
        }

        console.log(`[CLEANUP-2] Ditemukan ${allAbsences.length} data absensi untuk diperiksa`);

        let orphanedCount = 0;

        for (const absenceRecord of allAbsences) {
            const discordId = absenceRecord.discord_id;

            try {
                const userExistsInDb = validUserIds.includes(discordId);
                
                // ✅ PERBAIKAN: Gunakan retry dan null check
                const member = await withRetry(async () => {
                    return await guild.members.fetch(discordId).catch(() => null);
                }, 2, 500);
                
                const hasRequiredRole = member?.roles?.cache?.has(REQUIRED_ROLE_ID) ?? false;

                if (!userExistsInDb && !hasRequiredRole) {
                    console.log(`[CLEANUP-2] Data absensi ${absenceRecord.id} (user: ${discordId}) orphaned, menghapus...`);

                    // 3A. HAPUS GAMBAR BUKTI
                    if (absenceRecord.bukti_foto && isValidUrl(absenceRecord.bukti_foto)) {
                        try {
                            const namaFile = absenceRecord.bukti_foto.split('/').pop();
                            const pathLengkap = `absensi/${namaFile}`;
                            
                            await withRetry(async () => {
                                return await supabase.storage
                                    .from(STORAGE_BUCKET_NAME)
                                    .remove([pathLengkap]);
                            }, 2, 500);
                            
                            console.log(`  ✓ Gambar dihapus: ${namaFile}`);
                        } catch (imgErr) {
                            console.warn(`  ⚠ Error hapus gambar:`, imgErr.message);
                        }
                    }

                    // 3B. HAPUS DATA ABSENSI
                    const { error: delAbsenErr } = await supabase
                        .from('absensi_sasg')
                        .delete()
                        .eq('id', absenceRecord.id);

                    if (!delAbsenErr) {
                        console.log(`  ✓ Data absensi ID ${absenceRecord.id} dihapus`);
                        orphanedCount++;
                    } else {
                        console.warn(`  ⚠ Gagal hapus absensi: ${delAbsenErr.message}`);
                    }
                }
            } catch (err) {
                console.error(`  ✗ Error cleanup absensi ${absenceRecord.id}:`, err.message);
            }

            await new Promise(resolve => setTimeout(resolve, 800));
        }

        console.log(`[CLEANUP-2] ========== SELESAI (${orphanedCount} data orphaned dihapus) ==========\n`);
    } catch (errGlobal) {
        console.error("[CRITICAL ERROR] cleanupOrphanedAbsences:", errGlobal.message);
    }
}

// --- FUNGSI TANDAI THREAD ARCHIVED ---
async function markThreadAsArchived(guild) {
    console.log("\n[ARCHIVE-THREAD] ========== MULAI ARCHIVE THREAD ==========");
    
    try {
        const forumChannel = await guild.channels.fetch(FORUM_CHANNEL_ID);
        if (!forumChannel) {
            console.error("[ERROR] Channel Forum tidak ditemukan.");
            return;
        }

        const { data: validUsers, error: fetchErr } = await supabase
            .from('users_master')
            .select('discord_id');

        if (fetchErr) {
            console.error("[DB ERROR]", fetchErr.message);
            return;
        }

        const validUserIds = validUsers ? validUsers.map(u => u.discord_id) : [];

        const threads = await withRetry(async () => {
            return await forumChannel.threads.fetchActive();
        }, 2, 500);

        console.log(`[ARCHIVE-THREAD] Ditemukan ${threads.threads.size} thread untuk diperiksa`);

        let markedCount = 0;

        for (const [, thread] of threads.threads) {
            const idMatch = thread.name.match(/^\[(\d+)\]/);
            
            if (!idMatch) continue;

            const discordId = idMatch[1];

            try {
                const userInDb = validUserIds.includes(discordId);

                const member = await withRetry(async () => {
                    return await guild.members.fetch(discordId).catch(() => null);
                }, 2, 500);
                
                const userInDiscord = member?.roles?.cache?.has(REQUIRED_ROLE_ID) ?? false;

                if (!userInDb || !userInDiscord) {
                    if (!thread.name.includes('[ARCHIVED]')) {
                        const newName = `[ARCHIVED] ${thread.name}`.substring(0, 100);
                        const reason = !userInDb ? "tidak ada di users_master" : "tidak punya required role";
                        
                        console.log(`[ARCHIVE-THREAD] Tandai thread (${reason}): "${thread.name}"`);
                        
                        try {
                            await thread.edit({ name: newName });
                            markedCount++;
                        } catch (err) {
                            console.warn(`[WARN] Gagal update thread: ${err.message}`);
                        }
                    }
                }
            } catch (err) {
                console.error(`[ERROR] Gagal proses thread: ${err.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, 800));
        }

        console.log(`[ARCHIVE-THREAD] ========== SELESAI (${markedCount} thread di-archive) ==========\n`);
    } catch (err) {
        console.error("[CRITICAL ERROR] markThreadAsArchived:", err.message);
    }
}

// --- FUNGSI PROSES FORUM LOGS ---
async function processForumLogs(guild) {
    console.log("\n[PROCESS-FORUM] ========== MULAI PROCESS FORUM LOGS ==========");
    
    try {
        const forumChannel = await guild.channels.fetch(FORUM_CHANNEL_ID);
        if (!forumChannel) {
            console.error("[ERROR] Channel Forum tidak ditemukan.");
            return;
        }

        const { data: logs, error: fetchError } = await supabase
            .from('absensi_sasg')
            .select('*')
            .eq('is_archived', false);

        if (fetchError) {
            console.error("[DATABASE ERROR]", fetchError.message);
            return;
        }

        if (!logs || logs.length === 0) {
            console.log("[PROCESS-FORUM] Tidak ada data absensi baru.");
            return;
        }

        console.log(`[PROCESS-FORUM] Ditemukan ${logs.length} data absensi untuk diproses`);

        for (let i = 0; i < logs.length; i++) {
            const log = logs[i];
            
            try {
                const statusKirim = log.tipe_absen || "HADIR";
                const alasanKirim = log.alasan || "Tidak ada keterangan";
                const namaUser = log.nama_anggota || "Unknown";
                const discordId = log.discord_id;

                console.log(`[PROCESS-FORUM] [${i + 1}/${logs.length}] Memproses: ${namaUser} (ID: ${discordId})`);

                const threads = await withRetry(async () => {
                    return await forumChannel.threads.fetchActive();
                }, 2, 500);
                
                let targetThread = threads.threads.find(t => 
                    t.name.includes(`[${discordId}]`)
                );

                if (!targetThread) {
                    console.log(`  → Membuat thread baru...`);
                    targetThread = await forumChannel.threads.create({
                        name: `[${discordId}] ${namaUser}`.substring(0, 100),
                        message: { content: `Logs Kehadiran Resmi - **${namaUser}**` },
                    });
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    const currentName = `[${discordId}] ${namaUser}`.substring(0, 100);
                    if (targetThread.name !== currentName) {
                        console.log(`  → Update nama thread...`);
                        await targetThread.edit({ name: currentName }).catch(err => {
                            console.warn(`  ⚠ Gagal update: ${err.message}`);
                        });
                    }
                }

                let warnaEmbed = 0x2ecc71;
                if (statusKirim === "IZIN") {
                    warnaEmbed = 0xf1c40f;
                } else if (statusKirim === "CUTI") {
                    warnaEmbed = 0xe67e22;
                }

                // Validasi & extract gambar
                const imageUrls = [];
                let hasImageUrl = false;

                if (log.bukti_foto && typeof log.bukti_foto === 'string') {
                    const urls = log.bukti_foto
                        .split(',')
                        .map(url => url.trim())
                        .filter(url => isValidUrl(url));
                    
                    imageUrls.push(...urls);
                    hasImageUrl = true;
                    
                    if (imageUrls.length > 0) {
                        console.log(`  → Ditemukan ${imageUrls.length} gambar`);
                    }
                }

                // Buat main embed
                const reportEmbed = new EmbedBuilder()
                    .setTitle(`LOG KEHADIRAN - ${statusKirim}`)
                    .setColor(warnaEmbed)
                    .addFields(
                        { name: 'Nama Anggota', value: namaUser, inline: true },
                        { name: 'Pangkat', value: log.pangkat || "-", inline: true },
                        { name: 'Divisi', value: log.divisi || "-", inline: true },
                        { name: 'Jam Duty', value: log.jam_duty || "-", inline: true },
                        { name: 'Kegiatan', value: log.kegiatan || "-", inline: false },
                        { name: 'Keterangan/Alasan', value: alasanKirim, inline: false }
                    )
                    .setTimestamp(new Date(log.created_at))
                    .setFooter({ text: "SASG Attendance System" });

                // Tambah field jika tidak ada gambar
                if (imageUrls.length === 0 && hasImageUrl) {
                    reportEmbed.addFields({
                        name: 'Bukti Gambar',
                        value: '⚠️ File bukti tidak ditemukan di storage atau URL tidak valid.',
                        inline: false
                    });
                } else if (!log.bukti_foto) {
                    reportEmbed.addFields({
                        name: 'Bukti Gambar',
                        value: '⚠️ Tidak melampirkan gambar.',
                        inline: false
                    });
                }

                // Buat array embeds
                const embeds = [reportEmbed];

                if (imageUrls.length > 0) {
                    imageUrls.forEach((url, index) => {
                        const imgEmbed = new EmbedBuilder()
                            .setImage(url)
                            .setColor(warnaEmbed)
                            .setTitle(`Bukti Gambar ${index + 1}/${imageUrls.length}`)
                            .setFooter({ text: `Image ${index + 1} dari ${imageUrls.length}` });
                        embeds.push(imgEmbed);
                    });
                }

                // Kirim embeds
                try {
                    await targetThread.send({ embeds });
                    console.log(`  ✓ Log terkirim (${imageUrls.length} gambar)`);
                } catch (sendErr) {
                    console.error(`  ✗ GAGAL KIRIM: ${sendErr.message}`);
                    continue;
                }

                await new Promise(resolve => setTimeout(resolve, 2000));

                // Hapus gambar dari storage
                if (imageUrls.length > 0) {
                    for (const imageUrl of imageUrls) {
                        try {
                            const ambilNamaFile = imageUrl.split('/').pop();
                            const pathLengkap = `absensi/${ambilNamaFile}`;
                            
                            await withRetry(async () => {
                                return await supabase.storage
                                    .from(STORAGE_BUCKET_NAME)
                                    .remove([pathLengkap]);
                            }, 2, 500);
                            
                            console.log(`  ✓ File dihapus: ${ambilNamaFile}`);
                        } catch (storageErr) {
                            console.warn(`  ⚠ Error hapus storage:`, storageErr.message);
                        }
                    }
                }

                // Archive record
                try {
                    const { error: upError } = await supabase
                        .from('absensi_sasg')
                        .update({ is_archived: true })
                        .eq('id', log.id);

                    if (upError) {
                        console.error(`  ✗ Gagal archive: ${upError.message}`);
                    } else {
                        console.log(`  ✓ Data di-archive`);
                    }
                } catch (archiveErr) {
                    console.error(`  ✗ Error archive:`, archiveErr.message);
                }

            } catch (errLoop) {
                console.error(`[ERROR] Gagal proses data ID ${log.id}:`, errLoop.message);
            }
        }
        
        console.log("[PROCESS-FORUM] ========== SELESAI ==========\n");
    } catch (errGlobal) {
        console.error("[CRITICAL ERROR] processForumLogs:", errGlobal.message);
    }
}

// --- FUNGSI PENGECEKAN ABSENSI (REMINDER) ---
async function checkMissingAbsence(channel) {
    try {
        const { data: listUser, error: errU } = await supabase.from('users_master').select('discord_id');
        if (errU) return;

        const hariIni = new Date();
        hariIni.setHours(0, 0, 0, 0);

        const { data: listAbsen, error: errA } = await supabase
            .from('absensi_sasg')
            .select('discord_id')
            .gte('created_at', hariIni.toISOString());

        if (errA) return;

        const sudahAbsen = listAbsen.map(u => u.discord_id);
        const belumAbsen = listUser.filter(u => !sudahAbsen.includes(u.discord_id));

        if (belumAbsen.length > 0) {
            let mentionBelum = "";
            belumAbsen.forEach(user => {
                mentionBelum += `<@${user.discord_id}> `;
            });

            await channel.send(`⚠️ **REMINDER ABSENSI**\nAnggota berikut belum absen hari ini:\n${mentionBelum}\n\nSilakan absen di: https://san-andreas-police-departement.netlify.app/\n@everyone`);
        }
    } catch (e) {
        console.error("Reminder Error:", e.message);
    }
}

// --- MAIN TASK FUNCTION ---
async function runSasgTask() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`START TASK - ${new Date().toLocaleString('id-ID', {timeZone: 'Asia/Jakarta'})}`);
    console.log(`${'='.repeat(60)}`);
    
    const serverGuild = client.guilds.cache.get(DISCORD_GUILD_ID);
    if (!serverGuild) {
        console.error("[ERROR] Guild tidak ditemukan!");
        return;
    }

    try {
        // PHASE 1: CLEANUP DATA LAMA
        await cleanupUsersWithoutRole(serverGuild);
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        await cleanupOrphanedAbsences(serverGuild);
        await new Promise(resolve => setTimeout(resolve, 1500));

        // PHASE 1B: TANDAI THREAD ARCHIVED
        await markThreadAsArchived(serverGuild);
        await new Promise(resolve => setTimeout(resolve, 1500));

        // PHASE 2: SINKRONISASI DATA BARU
        console.log("\n[SYNC] ========== MULAI SINKRONISASI MEMBERS ==========");
        
        const daftarMember = await getMembersSafe(serverGuild);
        const arrayDataMaster = [];

        console.log(`[SYNC] Memproses ${daftarMember.size} members...`);

        daftarMember.forEach(member => {
            if (member?.roles?.cache?.has(REQUIRED_ROLE_ID)) {
                let pnk = "-";
                let div = "-";

                member.roles.cache.forEach(role => {
                    if (PANGKAT_MAP[role.id]) pnk = PANGKAT_MAP[role.id];
                    if (DIVISI_MAP[role.id]) div = DIVISI_MAP[role.id];
                });

                const namaDisplay = member.nickname || member.user.username;

                arrayDataMaster.push({
                    discord_id: member.id,
                    nama_anggota: namaDisplay,
                    pangkat: pnk,
                    divisi: div,
                    is_admin: member.roles.cache.has(ADMIN_ROLE_ID),
                    last_login: new Date().toISOString()
                });
            }
        });

        if (arrayDataMaster.length > 0) {
            await supabase.from('users_master').upsert(arrayDataMaster, { onConflict: 'discord_id' });
            console.log(`[SYNC] ✓ ${arrayDataMaster.length} user berhasil di-upsert`);
        }
        console.log("[SYNC] ========== SELESAI ==========\n");

        // PHASE 3: PROSES FORUM
        await processForumLogs(serverGuild);

        // PHASE 4: REMINDER ABSENSI
        console.log("\n[REMINDER] Mengecek jadwal reminder...");
        const waktuJkt = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Jakarta"}));
        const jamSekarang = waktuJkt.getHours();
        const menitSekarang = waktuJkt.getMinutes();

        if (menitSekarang <= 10) {
            if (jamSekarang === 19 || jamSekarang === 22) {
                console.log("[REMINDER] Mengirim reminder absensi...");
                const channelAnnounce = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
                if (channelAnnounce) await checkMissingAbsence(channelAnnounce);
            }
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log("✅ TASK COMPLETED SUCCESSFULLY");
        console.log(`${'='.repeat(60)}\n`);
    } catch (err) {
        console.error(`\n${'='.repeat(60)}`);
        console.error("❌ MAIN TASK ERROR:", err.message);
        console.error(err.stack);
        console.error(`${'='.repeat(60)}\n`);
    }
}

// --- EVENT BOT READY ---
client.once('ready', () => {
    console.log("\n========================================");
    console.log(`✅ BOT SASG READY`);
    console.log(`📍 Username: ${client.user.tag}`);
    console.log(`🆔 User ID: ${client.user.id}`);
    console.log("Status: Online & Monitoring");
    console.log("========================================\n");
    
    // Jalankan task pertama kali
    runSasgTask();
    
    // Jalankan setiap 10 menit
    setInterval(runSasgTask, 600000);
});

// --- EVENT BOT ERROR ---
client.on('error', (error) => {
    console.error('[CLIENT ERROR]', error);
});

client.on('warn', (warning) => {
    console.warn('[CLIENT WARN]', warning);
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGTERM', async () => {
    console.log('\n[SHUTDOWN] Bot sedang shutdown...');
    await client.destroy();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Bot sedang shutdown (SIGINT)...');
    await client.destroy();
    process.exit(0);
});

// --- LOGIN ---
client.login(process.env.DISCORD_BOT_TOKEN);
