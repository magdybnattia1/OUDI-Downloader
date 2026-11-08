package com.oudi.downloader

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.webkit.URLUtil
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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

private val Gold = Color(0xFFD6AE45)
private val Black = Color(0xFF101010)
private val Panel = Color(0xFF1B1B1B)
private val Muted = Color(0xFFB9B2A1)

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

    MaterialTheme(colorScheme = darkColorScheme(
        primary = Gold, onPrimary = Black, background = Black, surface = Panel,
        onBackground = Color.White, onSurface = Color.White
    )) {
        Surface(Modifier.fillMaxSize(), color = Black) {
            Column(Modifier.fillMaxSize().padding(20.dp)) {
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
                Text("حمّل الملفات والفيديوهات من الروابط المباشرة المسموح بتنزيلها.", color = Muted, fontSize = 13.sp)
                Spacer(Modifier.height(22.dp))
                Card(colors = CardDefaults.cardColors(containerColor = Panel), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        OutlinedTextField(
                            value = url, onValueChange = { url = it },
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
                                    status = "تم التعرف على رابط يوتيوب. لا يمكن تنزيل صفحة المشاهدة مباشرة؛ يمكنك فتح الفيديو عبر تطبيق يوتيوب الرسمي."
                                } else {
                                    try {
                                        val guessedFileName = URLUtil.guessFileName(clean, null, null)
                                        val fileName = buildDownloadFileName(title, guessedFileName)
                                        val request = DownloadManager.Request(Uri.parse(clean))
                                            .setTitle(fileName)
                                            .setDescription("OUDI Downloader")
                                            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                                            .setAllowedOverMetered(true)
                                            .setAllowedOverRoaming(false)
                                            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                                        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                                        val downloadId = manager.enqueue(request)
                                        status = "تم إرسال طلب التحميل إلى أندرويد (رقم الطلب: $downloadId). تابع حالة التنزيل من إشعارات الهاتف أو تطبيق التنزيلات."
                                    } catch (e: Exception) {
                                        status = "تعذر بدء التحميل: ${e.message ?: "خطأ غير معروف"}"
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Black),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Icon(Icons.Default.Download, null)
                            Spacer(Modifier.width(8.dp))
                            Text("ابدأ التحميل", fontWeight = FontWeight.Bold)
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
                Spacer(Modifier.weight(1f))
                Text("الإصدار التأسيسي 0.1.0 • OUDI", color = Color.Gray, fontSize = 11.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
}