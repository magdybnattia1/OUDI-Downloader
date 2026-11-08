package com.oudi.downloader

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.webkit.URLUtil
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

private val Gold = Color(0xFFD6AE45)
private val Black = Color(0xFF101010)
private val Panel = Color(0xFF1B1B1B)
private val Muted = Color(0xFFB9B2A1)

private data class DownloadFormat(
    val id: String,
    val label: String,
    val mimeType: String,
    val url: String
)

private fun buildDownloadFileName(requestedName: String, guessedName: String): String {
    val fallback = guessedName.substringAfterLast('/').substringAfterLast('\\').ifBlank { "download" }
    val cleaned = requestedName.trim()
        .substringAfterLast('/')
        .substringAfterLast('\\')
        .map { ch ->
            if (ch.isISOControl() || ch in ":*?\"<>|") '_' else ch
        }
        .joinToString("")
        .take(120)
    if (cleaned.isBlank()) return fallback

    val hasExtension = cleaned.substringAfterLast('.', "").isNotBlank() && !cleaned.endsWith('.')
    val fallbackExtension = fallback.substringAfterLast('.', "").takeIf { it.isNotBlank() }
    return if (hasExtension || fallbackExtension == null) cleaned else "$cleaned.$fallbackExtension"
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OudiApp(this) }
    }
}

@Composable
private fun OudiApp(context: Context) {
    var url by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("ألصق رابط ملف يسمح مالكه بتنزيله") }
    var availableFormats by remember { mutableStateOf<List<DownloadFormat>>(emptyList()) }
    var selectedFormat by remember { mutableStateOf<DownloadFormat?>(null) }
    var inspectedFileName by remember { mutableStateOf("") }
    var isInspecting by remember { mutableStateOf(false) }
    var formatMenuExpanded by remember { mutableStateOf(false) }

    MaterialTheme(colorScheme = darkColorScheme(
        primary = Gold, onPrimary = Black, background = Black, surface = Panel,
        onBackground = Color.White, onSurface = Color.White
    )) {
        Surface(Modifier.fillMaxSize(), color = Black) {
            Column(
                Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState())
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(46.dp).background(Gold, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                        Text("O", color = Black, fontSize = 27.sp, fontWeight = FontWeight.Black)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("OUDI", color = Gold, fontSize = 25.sp, fontWeight = FontWeight.ExtraBold)
                        Text("DOWNLOADER", color = Muted, fontSize = 11.sp, letterSpacing = 2.sp)
                    }
                }
                Spacer(Modifier.height(28.dp))
                Text("مدير التحميلات", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Text(
                    "حمّل الملفات والفيديوهات من الروابط المباشرة المسموح بتنزيلها. تظهر الجودات فقط إذا أتاحها المصدر.",
                    color = Muted,
                    fontSize = 13.sp
                )
                Spacer(Modifier.height(22.dp))
                Card(colors = CardDefaults.cardColors(containerColor = Panel), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        OutlinedTextField(
                            value = url,
                            onValueChange = {
                                url = it
                                availableFormats = emptyList()
                                selectedFormat = null
                                inspectedFileName = ""
                            },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("رابط التحميل") },
                            leadingIcon = { Icon(Icons.Default.Link, null, tint = Gold) },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Gold, focusedLabelColor = Gold,
                                cursorColor = Gold, unfocusedBorderColor = Color.DarkGray
                            )
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = title, onValueChange = { title = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("اسم الملف (اختياري)") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Gold, focusedLabelColor = Gold,
                                cursorColor = Gold, unfocusedBorderColor = Color.DarkGray
                            )
                        )
                        Spacer(Modifier.height(14.dp))
                        Button(
                            onClick = {
                                val clean = url.trim()
                                val parsed = runCatching { Uri.parse(clean) }.getOrNull()
                                val host = parsed?.host?.lowercase().orEmpty()
                                val isYouTubePage = host == "youtu.be" || host == "youtube.com" ||
                                    host.endsWith(".youtube.com") || host == "youtube-nocookie.com" ||
                                    host.endsWith(".youtube-nocookie.com")
                                if (!(clean.startsWith("https://") || clean.startsWith("http://"))) {
                                    status = "أدخل رابط HTTP أو HTTPS صحيحًا"
                                } else if (isYouTubePage) {
                                    availableFormats = emptyList()
                                    selectedFormat = null
                                    status = "رابط مشاهدة YouTube ليس رابط ملف قابلًا للتنزيل. استخدم خيارات YouTube الرسمية."
                                } else {
                                    isInspecting = true
                                    availableFormats = emptyList()
                                    selectedFormat = null
                                    status = "جاري فحص الرابط وتجهيز خيارات الملف..."
                                    Thread {
                                        var resultMessage = ""
                                        var foundFormats: List<DownloadFormat> = emptyList()
                                        var foundFileName: String? = null
                                        try {
                                            val encoded = URLEncoder.encode(clean, "UTF-8")
                                            val connection = (URL("https://oudi-downloader.mangalefi.workers.dev/api/inspect?url=$encoded").openConnection() as HttpURLConnection).apply {
                                                requestMethod = "GET"
                                                connectTimeout = 15000
                                                readTimeout = 15000
                                                setRequestProperty("Accept", "application/json")
                                            }
                                            try {
                                                val code = connection.responseCode
                                                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                                                val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                                                val json = JSONObject(body.ifBlank { "{}" })
                                                if (code !in 200..299 || !json.optBoolean("ok", false)) {
                                                    resultMessage = json.optString("error", "تعذر فحص رابط الملف")
                                                } else {
                                                    val formats = json.optJSONArray("formats")
                                                    if (formats == null || formats.length() == 0) {
                                                        resultMessage = "لم يعثر السيرفر على صيغة تنزيل متاحة"
                                                    } else {
                                                        foundFormats = buildList {
                                                            for (index in 0 until formats.length()) {
                                                                val item = formats.optJSONObject(index) ?: continue
                                                                val itemUrl = item.optString("url").takeIf { it.isNotBlank() && it != "null" } ?: continue
                                                                add(
                                                                    DownloadFormat(
                                                                        id = item.optString("id", "format-$index"),
                                                                        label = item.optString("label").takeIf { it.isNotBlank() && it != "null" }
                                                                            ?: "خيار ${index + 1}",
                                                                        mimeType = item.optString("mimeType").takeIf { it.isNotBlank() && it != "null" }.orEmpty(),
                                                                        url = itemUrl
                                                                    )
                                                                )
                                                            }
                                                        }
                                                        foundFileName = json.optString("fileName")
                                                            .takeIf { it.isNotBlank() && it != "null" }
                                                        if (foundFormats.isEmpty()) {
                                                            resultMessage = "لم يعثر السيرفر على روابط تنزيل صالحة ضمن النتائج"
                                                        } else {
                                                            resultMessage = "تم فحص الرابط بنجاح"
                                                        }
                                                    }
                                                }
                                            } finally {
                                                connection.disconnect()
                                            }
                                        } catch (e: Exception) {
                                            resultMessage = "تعذر الاتصال بسيرفر OUDI: ${e.message ?: "تحقق من الإنترنت وحاول مجددًا"}"
                                        }

                                        Handler(Looper.getMainLooper()).post {
                                            isInspecting = false
                                            availableFormats = foundFormats
                                            selectedFormat = foundFormats.firstOrNull()
                                            inspectedFileName = foundFileName.orEmpty()
                                            status = when (foundFormats.size) {
                                                0 -> resultMessage
                                                1 -> "المصدر أتاح خيار تنزيل واحدًا فقط. لا توجد جودات أخرى معلنة من المصدر."
                                                else -> "تم العثور على ${foundFormats.size} خيارات. اختر الصيغة والجودة التي تريدها."
                                            }
                                        }
                                    }.start()
                                }
                            },
                            enabled = !isInspecting,
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Black),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Icon(Icons.Default.Link, null)
                            Spacer(Modifier.width(8.dp))
                            Text(if (isInspecting) "جاري فحص الرابط..." else "افحص الرابط واعرض الصيغ", fontWeight = FontWeight.Bold)
                        }

                        if (availableFormats.isNotEmpty()) {
                            Spacer(Modifier.height(16.dp))
                            Text("الصيغة والجودة المتاحة", color = Gold, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.height(6.dp))
                            Box(Modifier.fillMaxWidth()) {
                                OutlinedButton(
                                    onClick = { formatMenuExpanded = true },
                                    modifier = Modifier.fillMaxWidth(),
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                                    shape = RoundedCornerShape(12.dp)
                                ) {
                                    Text(
                                        selectedFormat?.let {
                                            if (it.mimeType.isBlank()) it.label else "${it.label} • ${it.mimeType}"
                                        } ?: "اختر الصيغة"
                                    )
                                }
                                DropdownMenu(
                                    expanded = formatMenuExpanded,
                                    onDismissRequest = { formatMenuExpanded = false }
                                ) {
                                    availableFormats.forEach { format ->
                                        DropdownMenuItem(
                                            text = {
                                                Column {
                                                    Text(format.label)
                                                    if (format.mimeType.isNotBlank()) {
                                                        Text(format.mimeType, color = Muted, fontSize = 11.sp)
                                                    }
                                                }
                                            },
                                            onClick = {
                                                selectedFormat = format
                                                formatMenuExpanded = false
                                            }
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.height(10.dp))
                            Button(
                                onClick = {
                                    selectedFormat?.let { format ->
                                        try {
                                            val mediaUri = Uri.parse(format.url)
                                            if (mediaUri.scheme !in listOf("http", "https")) {
                                                status = "رابط التنزيل الناتج غير صالح"
                                            } else {
                                                val guessedFileName = URLUtil.guessFileName(format.url, null, format.mimeType)
                                                val preferredName = title.ifBlank { inspectedFileName }
                                                val fileName = buildDownloadFileName(preferredName, guessedFileName)
                                                val request = DownloadManager.Request(mediaUri)
                                                    .setTitle(fileName)
                                                    .setDescription("OUDI Downloader • ${format.label}")
                                                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                                                    .setAllowedOverMetered(true)
                                                    .setAllowedOverRoaming(false)
                                                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                                                val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                                                val downloadId = manager.enqueue(request)
                                                status = "بدأ تنزيل ${format.label} إلى مجلد Downloads (رقم الطلب: $downloadId)."
                                            }
                                        } catch (e: Exception) {
                                            status = "تعذر بدء التنزيل: ${e.message ?: "خطأ غير معروف"}"
                                        }
                                    }
                                },
                                enabled = selectedFormat != null,
                                modifier = Modifier.fillMaxWidth().height(50.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Black),
                                shape = RoundedCornerShape(12.dp)
                            ) {
                                Icon(Icons.Default.Download, null)
                                Spacer(Modifier.width(8.dp))
                                Text("تحميل الصيغة المختارة", fontWeight = FontWeight.Bold)
                            }
                        }

                        val cleanForYouTube = url.trim()
                        val parsedForYouTube = runCatching { Uri.parse(cleanForYouTube) }.getOrNull()
                        val youtubeHost = parsedForYouTube?.host?.lowercase().orEmpty()
                        val isYouTubeLink = youtubeHost == "youtu.be" ||
                            youtubeHost == "youtube.com" || youtubeHost.endsWith(".youtube.com") ||
                            youtubeHost == "youtube-nocookie.com" || youtubeHost.endsWith(".youtube-nocookie.com")
                        if (isYouTubeLink) {
                            Spacer(Modifier.height(10.dp))
                            OutlinedButton(
                                onClick = {
                                    try {
                                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(cleanForYouTube))
                                        context.startActivity(intent)
                                    } catch (e: Exception) {
                                        status = "تعذر فتح رابط يوتيوب"
                                    }
                                },
                                modifier = Modifier.fillMaxWidth().height(50.dp),
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = Gold),
                                shape = RoundedCornerShape(14.dp)
                            ) {
                                Icon(Icons.Default.PlayArrow, null)
                                Spacer(Modifier.width(8.dp))
                                Text("افتح الفيديو على يوتيوب")
                            }
                        }
                    }
                }
                Spacer(Modifier.height(18.dp))
                Card(colors = CardDefaults.cardColors(containerColor = Panel), shape = RoundedCornerShape(16.dp)) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.PlayArrow, null, tint = Gold)
                        Spacer(Modifier.width(10.dp))
                        Text(status, color = Muted, fontSize = 13.sp)
                    }
                }
                Spacer(Modifier.height(24.dp))
                Text("الإصدار التأسيسي 0.1.0 • OUDI", color = Color.Gray, fontSize = 11.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
}
