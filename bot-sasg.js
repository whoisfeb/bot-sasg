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
const STORAGE_BUCKET_NAME = "bukti-hadir"; 
const REQUIRED_ROLE_ID = "1492398964610170940"; 
const ADMIN_ROLE_ID = "1444910578266148897"; 
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
// --- FUNGSI VALIDASI URL ---
function isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    // Trim whitespace
    url = url.trim();
    
    // Check if starts with http
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
}

// --- FUNGSI 1: CLEANUP USER YANG TIDAK PUNYA REQUIRED ROLE DARI USERS_MASTER ---
async function cleanupUsersWithoutRole(guild) {
    console.log("[CLEANUP-1] Memulai cleanup user tanpa required role dari users_master...");
    
    try {
        // 1. AMBIL SEMUA USER DI users_master
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

        let cleanupCount = 0;

        // 2. PROSES SETIAP USER
        for (const userRecord of allUsersInDb) {
            const discordId = userRecord.discord_id;
            
            try {
                // Cek apakah user masih ada di Discord & punya required role
                const member = await guild.members.fetch(discordId).catch(() => null);
                
                if (!member || !member.roles.cache.has(REQUIRED_ROLE_ID)) {
                    console.log(`[CLEANUP-1] User ${discordId} tidak punya required role, menghapus...`);

                    // 2A. HAPUS GAMBAR BUKTI DARI STORAGE
                    const { data: absenRecords, error: absenErr } = await supabase
                        .from('absensi_sapd')
                        .select('id, bukti_foto')
                        .eq('discord_id', discordId);

                    if (!absenErr && absenRecords && absenRecords.length > 0) {
                        for (const record of absenRecords) {
                            if (record.bukti_foto && isValidUrl(record.bukti_foto)) {
                                try {
                                    const namaFile = record.bukti_foto.split('/').pop();
                                    const pathLengkap = `absensi/${namaFile}`;
                                    
                                    const { error: delStorageErr } = await supabase.storage
                                        .from(STORAGE_BUCKET_NAME)
                                        .remove([pathLengkap]);
                                    
                                    if (!delStorageErr) {
                                        console.log(`  ✓ Gambar dihapus: ${namaFile}`);
                                    } else {
                                        console.warn(`  ⚠ Gagal hapus gambar ${namaFile}: ${delStorageErr.message}`);
                                    }
                                } catch (imgErr) {
                                    console.warn(`  ⚠ Error hapus gambar:`, imgErr.message);
                                }
                            }
                        }
                    }

                    // 2B. HAPUS SEMUA DATA ABSENSI USER
                    const { error: delAbsenErr } = await supabase
                        .from('absensi_sapd')
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

            // Jeda untuk avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log(`[CLEANUP-1] Selesai. Total dihapus: ${cleanupCount} user`);
    } catch (errGlobal) {
        console.error("[CRITICAL ERROR] cleanupUsersWithoutRole:", errGlobal.message);
    }
}

// --- FUNGSI 2: CLEANUP ABSENSI DARI USER YANG SUDAH TIDAK ADA DI USERS_MASTER ---
async function cleanupOrphanedAbsences(guild) {
    console.log("[CLEANUP-2] Memulai cleanup data absensi yang orphaned...");
    
    try {
        // 1. AMBIL SEMUA USER DI users_master
        const { data: validUsers, error: fetchValidErr } = await supabase
            .from('users_master')
            .select('discord_id');

        if (fetchValidErr) {
            console.error("[DB ERROR] Gagal fetch users_master:", fetchValidErr.message);
            return;
        }

        const validUserIds = validUsers ? validUsers.map(u => u.discord_id) : [];

        // 2. AMBIL SEMUA DATA DI absensi_sapd
        const { data: allAbsences, error: fetchAbsenErr } = await supabase
            .from('absensi_sapd')
            .select('id, discord_id, bukti_foto');

        if (fetchAbsenErr) {
            console.error("[DB ERROR] Gagal fetch absensi_sapd:", fetchAbsenErr.message);
            return;
        }

        if (!allAbsences || allAbsences.length === 0) {
            console.log("[CLEANUP-2] Tidak ada data absensi.");
            return;
        }

        let orphanedCount = 0;

        // 3. CARI DATA ABSENSI YANG USERNYA TIDAK ADA DI users_master
        for (const absenceRecord of allAbsences) {
            const discordId = absenceRecord.discord_id;

            try {
                // Cek apakah user ada di users_master
                const userExistsInDb = validUserIds.includes(discordId);
                
                // Cek apakah user masih ada di Discord & punya required role
                const member = await guild.members.fetch(discordId).catch(() => null);
                const hasRequiredRole = member ? member.roles.cache.has(REQUIRED_ROLE_ID) : false;

                // Jika user tidak ada di DB dan tidak punya required role, hapus absensi
                if (!userExistsInDb && !hasRequiredRole) {
                    console.log(`[CLEANUP-2] Data absensi ${absenceRecord.id} (user: ${discordId}) orphaned, menghapus...`);

                    // 3A. HAPUS GAMBAR BUKTI JIKA ADA & VALID
                    if (absenceRecord.bukti_foto && isValidUrl(absenceRecord.bukti_foto)) {
                        try {
                            const namaFile = absenceRecord.bukti_foto.split('/').pop();
                            const pathLengkap = `absensi/${namaFile}`;
                            
                            const { error: delStorageErr } = await supabase.storage
                                .from(STORAGE_BUCKET_NAME)
                                .remove([pathLengkap]);
                            
                            if (!delStorageErr) {
                                console.log(`  ✓ Gambar dihapus: ${namaFile}`);
                            } else {
                                console.warn(`  ⚠ Gagal hapus gambar: ${delStorageErr.message}`);
                            }
                        } catch (imgErr) {
                            console.warn(`  ⚠ Error hapus gambar:`, imgErr.message);
                        }
                    }

                    // 3B. HAPUS DATA ABSENSI
                    const { error: delAbsenErr } = await supabase
                        .from('absensi_sapd')
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

            // Jeda untuk avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log(`[CLEANUP-2] Selesai. Total dihapus: ${orphanedCount} data absensi orphaned`);
    } catch (errGlobal) {
        console.error("[CRITICAL ERROR] cleanupOrphanedAbsences:", errGlobal.message);
    }
}

// --- FUNGSI 3: TANDAI THREAD SEBAGAI ARCHIVED UNTUK USER YANG TIDAK AKTIF ---
async function markThreadAsArchived(guild) {
    console.log("[ARCHIVE-THREAD] Memulai marking thread user yang tidak aktif...");
    
    try {
        const forumChannel = await guild.channels.fetch(FORUM_CHANNEL_ID);
        if (!forumChannel) {
            console.error("[ERROR] Channel Forum tidak ditemukan.");
            return;
        }

        // Ambil user valid dari users_master (yang masih punya role)
        const { data: validUsers, error: fetchErr } = await supabase
            .from('users_master')
            .select('discord_id');

        if (fetchErr) {
            console.error("[DB ERROR]", fetchErr.message);
            return;
        }

        const validUserIds = validUsers ? validUsers.map(u => u.discord_id) : [];

        // Ambil semua thread
        const threads = await forumChannel.threads.fetchActive();

        let markedCount = 0;

        for (const [, thread] of threads.threads) {
            // Ekstrak discord ID dari nama thread
            const idMatch = thread.name.match(/^\[(\d+)\]/);
            
            if (!idMatch) continue;

            const discordId = idMatch[1];

            try {
                // KONDISI 1: User tidak ada di users_master
                const userInDb = validUserIds.includes(discordId);

                // KONDISI 2: User tidak ada di Discord atau tidak punya required role
                const member = await guild.members.fetch(discordId).catch(() => null);
                const userInDiscord = member ? member.roles.cache.has(REQUIRED_ROLE_ID) : false;

                // Jika TIDAK ada di DB ATAU TIDAK punya required role → tandai archived
                if (!userInDb || !userInDiscord) {
                    if (!thread.name.includes('[ARCHIVED]')) {
                        const newName = `[ARCHIVED] ${thread.name}`.substring(0, 100);
                        
                        const reason = !userInDb ? "tidak ada di users_master" : "tidak punya required role";
                        console.log(`[ARCHIVE-THREAD] Tandai thread (${reason}): "${thread.name}" → "${newName}"`);
                        
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

            // Jeda untuk avoid rate limit
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log(`[ARCHIVE-THREAD] Selesai. Total thread di-archive: ${markedCount}`);
    } catch (err) {
        console.error("[CRITICAL ERROR] markThreadAsArchived:", err.message);
    }
}

// --- FUNGSI UNTUK PROSES FORUM LOGS ---
async function processForumLogs(guild) {
    console.log("[DEBUG] Memulai proses pengecekan forum logs...");
    
    try {
        const forumChannel = await guild.channels.fetch(FORUM_CHANNEL_ID);
        if (!forumChannel) {
            console.error("[ERROR] Channel Forum tidak ditemukan.");
            return;
        }

        const { data: logs, error: fetchError } = await supabase
            .from('absensi_sapd')
            .select('*')
            .eq('is_archived', false);

        if (fetchError) {
            console.error("[DATABASE ERROR]", fetchError.message);
            return;
        }

        if (!logs || logs.length === 0) {
            console.log("[INFO] Tidak ada data absensi baru untuk dikirim.");
            return;
        }

        for (let i = 0; i < logs.length; i++) {
            const log = logs[i];
            
            try {
                const statusKirim = log.tipe_absen || "HADIR";
                const alasanKirim = log.alasan || "Tidak ada keterangan";
                const namaUser = log.nama_anggota || "Unknown";
                const discordId = log.discord_id;

                const threads = await forumChannel.threads.fetchActive();
                
                // === CARI THREAD BERDASARKAN DISCORD_ID ===
                let targetThread = threads.threads.find(t => 
                    t.name.includes(`[${discordId}]`)
                );

                if (!targetThread) {
                    console.log(`[INFO] Membuat thread baru untuk ${namaUser} (ID: ${discordId})`);
                    targetThread = await forumChannel.threads.create({
                        name: `[${discordId}] ${namaUser}`.substring(0, 100),
                        message: { content: `Logs Kehadiran Resmi - **${namaUser}**` },
                    });
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    // === UPDATE NAMA THREAD JIKA ADA PERUBAHAN NAMA ===
                    const currentName = `[${discordId}] ${namaUser}`.substring(0, 100);
                    if (targetThread.name !== currentName) {
                        console.log(`[INFO] Update nama thread: "${targetThread.name}" → "${currentName}"`);
                        await targetThread.edit({ name: currentName }).catch(err => {
                            console.warn(`[WARN] Gagal update nama thread: ${err.message}`);
                        });
                    }
                }

                let warnaEmbed = 0x2ecc71;
                if (statusKirim === "IZIN") {
                    warnaEmbed = 0xf1c40f;
                } else if (statusKirim === "CUTI") {
                    warnaEmbed = 0xe67e22;
                }

                // === VALIDASI & EXTRACT SEMUA GAMBAR ===
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
                        console.log(`  ✓ Ditemukan ${imageUrls.length} gambar untuk ID ${log.id}`);
                    } else {
                        console.log(`  ⚠ URL ditemukan tapi tidak valid untuk ID ${log.id}`);
                    }
                } else {
                    console.log(`  ℹ Tidak ada gambar untuk ID ${log.id}`);
                }

                // === BUAT MAIN EMBED ===
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
                    .setFooter({ text: "SAPD Attendance System" });

                // === TAMBAH FIELD JIKA TIDAK ADA GAMBAR ===
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

                // === BUAT ARRAY EMBEDS (MAIN + IMAGE EMBEDS) ===
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

                // === KIRIM SEMUA EMBEDS SEKALIGUS ===
                try {
                    await targetThread.send({ embeds });
                    console.log(`[SUCCESS] Log ID ${log.id} + ${imageUrls.length} gambar terkirim ke thread: ${namaUser}`);
                } catch (sendErr) {
                    console.error(`  ✗ GAGAL KIRIM ID ${log.id}: ${sendErr.message}`);
                    continue;
                }

                await new Promise(resolve => setTimeout(resolve, 2000));

                // === HAPUS SEMUA GAMBAR DARI STORAGE ===
                if (imageUrls.length > 0) {
                    for (const imageUrl of imageUrls) {
                        try {
                            const ambilNamaFile = imageUrl.split('/').pop();
                            const pathLengkap = `absensi/${ambilNamaFile}`;
                            
                            const { error: delError } = await supabase.storage
                                .from(STORAGE_BUCKET_NAME)
                                .remove([pathLengkap]);
                            
                            if (delError) {
                                console.warn(`  ⚠ Gagal hapus file ${ambilNamaFile}: ${delError.message}`);
                            } else {
                                console.log(`  ✓ File dihapus: ${ambilNamaFile}`);
                            }
                        } catch (storageErr) {
                            console.warn(`  ⚠ Error hapus storage:`, storageErr.message);
                        }
                    }
                }

                // === ARCHIVE RECORD ===
                try {
                    const { error: upError } = await supabase
                        .from('absensi_sapd')
                        .update({ is_archived: true })
                        .eq('id', log.id);

                    if (upError) {
                        console.error(`  ✗ Gagal archive ID ${log.id}: ${upError.message}`);
                    } else {
                        console.log(`  ✓ Data ID ${log.id} di-archive`);
                    }
                } catch (archiveErr) {
                    console.error(`  ✗ Error archive ID ${log.id}: ${archiveErr.message}`);
                }

            } catch (errLoop) {
                console.error(`[LOOP ERROR] Gagal memproses data ID ${log.id}:`, errLoop.message);
            }
        }
        
        console.log("[DEBUG] Selesai proses forum logs.");
    } catch (errGlobal) {
        console.error("[CRITICAL ERROR] processForumLogs:", errGlobal.message);
    }
}

// --- FUNGSI PENGECEKAN ANGGOTA (REMINDER) ---
async function checkMissingAbsence(channel) {
    try {
        const { data: listUser, error: errU } = await supabase.from('users_master').select('discord_id');
        if (errU) return;

        const hariIni = new Date();
        hariIni.setHours(0, 0, 0, 0);

        const { data: listAbsen, error: errA } = await supabase
            .from('absensi_sapd')
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

// --- TUGAS RUTIN (SINKRONISASI & FORUM) ---
async function runSapdTask() {
    console.log(`\n--- [START TASK ${new Date().toLocaleString()}] ---`);
    
    const serverGuild = client.guilds.cache.get(DISCORD_GUILD_ID);
    if (!serverGuild) return;

    try {
        // --- PHASE 1: CLEANUP DATA LAMA ---
        await cleanupUsersWithoutRole(serverGuild);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await cleanupOrphanedAbsences(serverGuild);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // --- PHASE 1B: TANDAI THREAD SEBAGAI ARCHIVED ---
        await markThreadAsArchived(serverGuild);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // --- PHASE 2: SINKRONISASI DATA BARU ---
        const daftarMember = await serverGuild.members.fetch();
        const arrayDataMaster = [];
        const idsAktif = [];

        daftarMember.forEach(member => {
            if (member.roles.cache.has(REQUIRED_ROLE_ID)) {
                let pnk = "-";
                let div = "-";

                member.roles.cache.forEach(role => {
                    if (PANGKAT_MAP[role.id]) pnk = PANGKAT_MAP[role.id];
                    if (DIVISI_MAP[role.id]) div = DIVISI_MAP[role.id];
                });

                const namaDisplay = member.nickname || member.user.username;
                idsAktif.push(member.id);

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

        // Simpan data terbaru
        if (arrayDataMaster.length > 0) {
            await supabase.from('users_master').upsert(arrayDataMaster, { onConflict: 'discord_id' });
            console.log(`[SYNC] ${arrayDataMaster.length} user berhasil di-upsert`);
        }

        // --- PHASE 3: PROSES FORUM ---
        await processForumLogs(serverGuild);

        // --- PHASE 4: REMINDER ABSENSI ---
        const waktuJkt = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Jakarta"}));
        const jamSekarang = waktuJkt.getHours();
        const menitSekarang = waktuJkt.getMinutes();

        if (menitSekarang <= 10) {
            if (jamSekarang === 19 || jamSekarang === 22) {
                const channelAnnounce = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID);
                if (channelAnnounce) await checkMissingAbsence(channelAnnounce);
            }
        }

        console.log("--- [TASK COMPLETED] ---\n");
    } catch (err) {
        console.error("Main Task Error:", err.message);
    }
}

// --- EVENT BOT READY ---
client.once('clientReady', () => {
    console.log("\n========================================");
    console.log(`Bot Terhubung Sebagai: ${client.user.tag}`);
    console.log("Status: Online & Monitoring Supabase");
    console.log("========================================\n");
    
    runSapdTask();
    setInterval(runSapdTask, 600000); // Jalankan setiap 10 menit
});

// --- LOGIN ---
client.login(process.env.DISCORD_BOT_TOKEN);
