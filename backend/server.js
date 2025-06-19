import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import http from "http"
import { Server } from "socket.io"
import dotenv from "dotenv"
import cookieParser from "cookie-parser"
import helmet from "helmet"
import morgan from "morgan"
import path from "path"
import serverless from "serverless-http"

// Import routes
import authRoutes from "./routes/auth.js"
import userRoutes from "./routes/users.js"
import courseRoutes from "./routes/courses.js"
import contentRoutes from "./routes/content.js"
import sessionRoutes from "./routes/sessions.js"
import paymentRoutes from "./routes/payments.js"
import enrollmentRoutes from "./routes/enrollments.js"
import progressRoutes from "./routes/progress.js"
import certificateRoutes from "./routes/certificates.js"
import adminRoutes from "./routes/admin.js"

// Load environment variables
dotenv.config()

// Initialize Express app
const app = express()
const server = http.createServer(app)

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
})

// Middleware
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(cors({
  origin: '*', // or explicitly set your frontend URL
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(helmet())
app.use(morgan("dev"))

// Serve static files
app.use(express.static(path.join(process.cwd(), "public")))

// Database connection
mongoose
  .connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err))

// Routes
app.use("/api/auth", authRoutes)
app.use("/api/user", userRoutes)
app.use("/api/courses", courseRoutes)
app.use("/api/courses", contentRoutes)
app.use("/api/courses", sessionRoutes)
app.use("/api/payments", paymentRoutes)
app.use("/api/enrollments", enrollmentRoutes)
app.use("/api/progress", progressRoutes)
app.use("/api/certificate", certificateRoutes)
app.use("/api/admin", adminRoutes)
app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Live Broadcasting Session Management
const sessions = new Map()

// Socket.IO WebRTC signaling for broadcasting
io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  // Join a broadcast room
  socket.on("join-broadcast", (roomId, userId, userType) => {
    socket.join(roomId)

    // Initialize room if it doesn't exist
    if (!sessions.has(roomId)) {
      sessions.set(roomId, {
        instructor: null,
        students: new Map(),
        messages: [],
        isLive: false,
        startTime: null,
      })
    }

    const session = sessions.get(roomId)

    // Handle instructor joining
    if (userType === "instructor") {
      session.instructor = {
        id: userId,
        socketId: socket.id,
        active: true,
      }
      session.isLive = true
      session.startTime = new Date()
      io.to(roomId).emit("broadcast-started", {
        instructorId: userId,
        startTime: session.startTime,
      })
    }
    // Handle student joining
    else {
      session.students.set(userId, {
        socketId: socket.id,
        active: true,
        joinedAt: new Date(),
      })

      // Notify instructor about new student
      if (session.instructor) {
        io.to(session.instructor.socketId).emit("student-joined", {
          roomId,
          userId,
          totalStudents: session.students.size,
        })
      }

      // Send session history to the new student
      socket.emit("session-info", {
        isLive: session.isLive,
        startTime: session.startTime,
        messages: session.messages,
        totalStudents: session.students.size,
      })
    }

    // Broadcast updated participant count
    io.to(roomId).emit("participants-updated", {
      count: session.students.size + (session.instructor ? 1 : 0),
    })

    // Handle WebRTC signaling
    socket.on("broadcast-signal", (signal) => {
      if (userType === "instructor") {
        // Broadcast signal to all students
        socket.to(roomId).emit("instructor-signal", {
          instructorId: userId,
          signal,
        })
      } else {
        // Send student signal to instructor only
        if (session.instructor) {
          io.to(session.instructor.socketId).emit("student-signal", {
            studentId: userId,
            signal,
          })
        }
      }
    })

    // Handle chat messages
    socket.on("broadcast-message", (message) => {
      const formattedMessage = {
        id: Date.now().toString(),
        userId,
        name: message.name || (userType === "instructor" ? "Instructor" : "Student"),
        text: message.text,
        timestamp: new Date(),
        userType,
      }

      // Store message in session history
      session.messages.push(formattedMessage)
      if (session.messages.length > 100) {
        session.messages.shift() // Keep only last 100 messages
      }

      // Broadcast message to all participants
      io.to(roomId).emit("new-message", formattedMessage)
    })

    // Handle instructor actions
    socket.on("instructor-action", (action) => {
      if (userType === "instructor") {
        switch (action.type) {
          case "mute-all":
            io.to(roomId).emit("instructor-command", {
              command: "mute-all",
            })
            break
          case "end-session":
            session.isLive = false
            io.to(roomId).emit("session-ended", {
              endTime: new Date(),
            })
            break
          case "toggle-recording":
            io.to(roomId).emit("recording-status", {
              isRecording: action.isRecording,
            })
            break
        }
      }
    })

    // Handle disconnect
    socket.on("disconnect", () => {
      if (userType === "instructor" && session.instructor?.id === userId) {
        // Instructor disconnected
        session.instructor.active = false
        io.to(roomId).emit("instructor-disconnected")
      } else {
        // Student disconnected
        session.students.delete(userId)

        // Notify instructor
        if (session.instructor) {
          io.to(session.instructor.socketId).emit("student-left", {
            roomId,
            userId,
            totalStudents: session.students.size,
          })
        }

        // Broadcast updated participant count
        io.to(roomId).emit("participants-updated", {
          count: session.students.size + (session.instructor?.active ? 1 : 0),
        })
      }

      // Clean up empty sessions after some time
      if (session.students.size === 0 && (!session.instructor || !session.instructor.active)) {
        setTimeout(() => {
          if (
            sessions.has(roomId) &&
            sessions.get(roomId).students.size === 0 &&
            (!sessions.get(roomId).instructor || !sessions.get(roomId).instructor.active)
          ) {
            sessions.delete(roomId)
            console.log(`Session ${roomId} cleaned up due to inactivity`)
          }
        }, 60000) // Clean up after 1 minute of inactivity
      }
    })
  })
})

// API endpoint to get active sessions
app.get("/api/live-sessions", (req, res) => {
  const activeSessions = []

  sessions.forEach((session, roomId) => {
    if (session.isLive) {
      activeSessions.push({
        id: roomId,
        startTime: session.startTime,
        participants: session.students.size + (session.instructor ? 1 : 0),
        instructorId: session.instructor?.id,
      })
    }
  })

  res.json({
    success: true,
    sessions: activeSessions,
  })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  })
})

// Start server
const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`API Documentation: http://localhost:${PORT}/api-docs`)
  console.log(`Admin Panel: http://localhost:${PORT}/admin`)
})
export const handler = serverless(app)
export default server
