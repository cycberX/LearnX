import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import MobileLayout from "../components/MobileLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import { Camera, CameraOff, Mic, MicOff, MessageSquare, Users, Monitor, PhoneOff } from "lucide-react";
import { Video, AlertCircle, UserPlus } from "lucide-react";
import io, { Socket } from "socket.io-client";

// Configuration
const API_URL =  "http://localhost:5000"

const LiveSession = () => {
  const { sessionId } = useParams()
  const [sessionData, setSessionData] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [isMicOn, setIsMicOn] = useState(false)
  const [newMessage, setNewMessage] = useState("")
  const [messages, setMessages] = useState([])
  const [activeTab, setActiveTab] = useState("chat")
  const [isRecording, setIsRecording] = useState(false)
  const [participantCount, setParticipantCount] = useState(0)
  const [isInstructor, setIsInstructor] = useState(false)
  const [isLive, setIsLive] = useState(false)
  const [connectedStudents, setConnectedStudents] = useState([])

  // Refs
  const socketRef = useRef(null)
  const localStreamRef = useRef(null)
  const peerConnectionsRef = useRef(new Map())
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const userId = "dfhgnjfm"

  // Load session data and initialize connection
  useEffect(() => {
    const fetchSessionData = async () => {
      try {
        // In a real app, fetch from API
        // const response = await fetch(`${API_URL}/api/sessions/${sessionId}`);
        // const data = await response.json();

        // Mock data for demo
        const mockData = {
          id: sessionId,
          title: "Live Coding Session",
          course: "Web Development Bootcamp",
          instructor: "Jane Smith",
          date: new Date().toISOString().split("T")[0],
          time: "14:00-15:30",
          description: "Learn how to build a real-time application with WebRTC and Socket.IO",
          participants: 0,
        }

        setSessionData(mockData)

        // Check if user is instructor (in real app, check from auth)
        const userRole = localStorage.getItem("userRole") || "student"
        setIsInstructor(userRole === "instructor")

        await initializeConnection(userRole === "instructor" ? "instructor" : "student")
        setIsLoading(false)
      } catch (error) {
        console.error("Error fetching session data:", error)
        toast({
          title: "Error",
          description: "Failed to load session data",
          variant: "destructive",
        })
      }
    }

    fetchSessionData()

    return () => {
      // Cleanup
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      socketRef.current?.disconnect()
      peerConnectionsRef.current.forEach((pc) => pc.close())
    }
  }, [sessionId])

  // Initialize WebRTC and Socket.IO connection
  const initializeConnection = async (userType: "instructor" | "student") => {
    try {
      // Connect to Socket.IO server
      socketRef.current = io(API_URL)
      // Join broadcast room
      socketRef.current.emit("join-broadcast", sessionId, userId, userType)

      // Handle session info
      socketRef.current.on("session-info", (info: any) => {
        setIsLive(info.isLive)
        setMessages(info.messages || [])
        setParticipantCount(info.totalStudents + 1) // +1 for instructor
      })

      // Handle broadcast started
      socketRef.current.on("broadcast-started", (data: any) => {
        setIsLive(true)
        toast({
          title: "Broadcast Started",
          description: "The instructor has started the broadcast",
        })
      })

      // Handle new messages
      socketRef.current.on("new-message", (message: Message) => {
        setMessages((prev) => [...prev, message])
      })

      // Handle participant updates
      socketRef.current.on("participants-updated", (data: any) => {
        setParticipantCount(data.count)
      })

      // Handle recording status
      socketRef.current.on("recording-status", (data: any) => {
        setIsRecording(data.isRecording)
      })

      // Handle session ended
      socketRef.current.on("session-ended", (data: any) => {
        setIsLive(false)
        toast({
          title: "Session Ended",
          description: "The broadcast has ended",
        })
      })

      // Setup WebRTC based on user type
      if (userType === "instructor") {
        await setupInstructorWebRTC()
      } else {
        await setupStudentWebRTC()
      }
    } catch (error) {
      console.error("Error initializing connection:", error)
      toast({
        title: "Connection Error",
        description: "Failed to connect to the broadcast",
        variant: "destructive",
      })
    }
  }

  // Setup WebRTC for instructor (broadcaster)
  const setupInstructorWebRTC = async () => {
    try {
      // Get local media stream
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      localStreamRef.current = stream

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      setIsCameraOn(true)
      setIsMicOn(true)

      // Handle student joined
      socketRef.current.on("student-joined", async (data: any) => {
        const { userId: studentId } = data

        // Create new peer connection for this student
        const peerConnection = createPeerConnection(studentId)

        // Add local tracks to the connection
        localStreamRef.current?.getTracks().forEach((track) => {
          peerConnection.addTrack(track, localStreamRef.current!)
        })

        // Create and send offer
        const offer = await peerConnection.createOffer()
        await peerConnection.setLocalDescription(offer)

        socketRef.current.emit("broadcast-signal", {
          type: "offer",
          sdp: peerConnection.localDescription,
          targetId: studentId,
        })

        // Update connected students list
        setConnectedStudents((prev) => [...prev, studentId])
      })

      // Handle student signal
      socketRef.current.on("student-signal", async (data: any) => {
        const { studentId, signal } = data

        if (!peerConnectionsRef.current.has(studentId)) {
          createPeerConnection(studentId)
        }

        const peerConnection = peerConnectionsRef.current.get(studentId)!

        if (signal.type === "answer") {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp))
        } else if (signal.type === "candidate") {
          await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate))
        }
      })

      // Handle student left
      socketRef.current.on("student-left", (data: any) => {
        const { userId: studentId } = data

        // Close and remove peer connection
        if (peerConnectionsRef.current.has(studentId)) {
          peerConnectionsRef.current.get(studentId)?.close()
          peerConnectionsRef.current.delete(studentId)
        }

        // Update connected students list
        setConnectedStudents((prev) => prev.filter((id) => id !== studentId))
      })
    } catch (error) {
      console.error("Error setting up instructor WebRTC:", error)
      toast({
        title: "Media Error",
        description: "Could not access camera or microphone",
        variant: "destructive",
      })
    }
  }

  // Setup WebRTC for student (viewer)
  const setupStudentWebRTC = async () => {
    try {
      // Create peer connection for instructor
      const peerConnection = createPeerConnection("instructor")

      // Handle instructor signal
      socketRef.current.on("instructor-signal", async (data: any) => {
        const { signal } = data

        if (signal.type === "offer") {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp))

          // Create and send answer
          const answer = await peerConnection.createAnswer()
          await peerConnection.setLocalDescription(answer)

          socketRef.current.emit("broadcast-signal", {
            type: "answer",
            sdp: peerConnection.localDescription,
          })
        } else if (signal.type === "candidate") {
          await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate))
        }
      })

      // Handle instructor disconnected
      socketRef.current.on("instructor-disconnected", () => {
        toast({
          title: "Instructor Disconnected",
          description: "The instructor has left the broadcast",
          variant: "destructive",
        })

        // Clear remote video
       peerConnection.ontrack = (event) => {
  const remoteStream = event.streams[0];
  if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStream) {
    remoteVideoRef.current.srcObject = remoteStream;
  }
};

      })

      // Handle instructor commands
      socketRef.current.on("instructor-command", (data: any) => {
        if (data.command === "mute-all") {
          // Mute local audio if it's on
          if (isMicOn && localStreamRef.current) {
            const audioTrack = localStreamRef.current.getAudioTracks()[0]
            if (audioTrack) {
              audioTrack.enabled = false
              setIsMicOn(false)
            }

            toast({
              title: "Muted",
              description: "The instructor has muted all participants",
            })
          }
        }
      })
    } catch (error) {
      console.error("Error setting up student WebRTC:", error)
      toast({
        title: "Connection Error",
        description: "Failed to connect to the broadcast",
        variant: "destructive",
      })
    }
  }

  // Create a new RTCPeerConnection
  const createPeerConnection = (peerId: string) => {
    const configuration = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
    }

    const peerConnection = new RTCPeerConnection(configuration)

    // Store the connection
    peerConnectionsRef.current.set(peerId, peerConnection)

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("broadcast-signal", {
          type: "candidate",
          candidate: event.candidate,
          targetId: peerId,
        })
      }
    }

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state with ${peerId}:`, peerConnection.connectionState)
    }

    // Handle incoming tracks (for students)
    peerConnection.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0]
      }
    }

    return peerConnection
  }

  // Toggle camera
  const toggleCamera = async () => {
    if (!localStreamRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        localStreamRef.current = stream

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }

        setIsCameraOn(true)
        setIsMicOn(true)
      } catch (error) {
        console.error("Error accessing media devices:", error)
        toast({
          title: "Error",
          description: "Could not access camera or microphone",
          variant: "destructive",
        })
        return
      }
    }

    const videoTrack = localStreamRef.current.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled
      setIsCameraOn(videoTrack.enabled)
    }
  }

  // Toggle microphone
  const toggleMic = () => {
    if (!localStreamRef.current) return

    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      setIsMicOn(audioTrack.enabled)
    }
  }

  // End call / leave session
  const endCall = () => {
    // Stop all tracks
    localStreamRef.current?.getTracks().forEach((track) => track.stop())

    // Close all peer connections
    peerConnectionsRef.current.forEach((pc) => pc.close())
    peerConnectionsRef.current.clear()

    // If instructor, notify server to end session
    if (isInstructor) {
      socketRef.current?.emit("instructor-action", {
        type: "end-session",
      })
    }

    // Disconnect socket
    socketRef.current?.disconnect()

    // Reset state
    setIsCameraOn(false)
    setIsMicOn(false)
    setIsLive(false)

    toast({
      title: "Session Ended",
      description: `You've left the broadcast`,
    })
  }

  // Toggle recording (instructor only)
  const toggleRecording = () => {
    if (!isInstructor) return

    const newRecordingState = !isRecording
    setIsRecording(newRecordingState)

    socketRef.current?.emit("instructor-action", {
      type: "toggle-recording",
      isRecording: newRecordingState,
    })

    toast({
      title: newRecordingState ? "Recording Started" : "Recording Stopped",
      description: newRecordingState ? "Session is now being recorded" : "Recording has been stopped",
    })
  }

  // Mute all participants (instructor only)
  const muteAllParticipants = () => {
    if (!isInstructor) return

    socketRef.current?.emit("instructor-action", {
      type: "mute-all",
    })

    toast({
      title: "All Participants Muted",
      description: "You have muted all participants",
    })
  }

  // Send chat message
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMessage.trim()) return

    socketRef.current?.emit("broadcast-message", {
      name: isInstructor ? "Instructor" : "You",
      text: newMessage,
    })

    setNewMessage("")
  }

  if (isLoading) {
    return (
      <MobileLayout title="Live Broadcast" showBackButton>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      </MobileLayout>
    )
  }

  return (
    <MobileLayout title={sessionData?.title || "Live Broadcast"} showBackButton>
      <div className="space-y-4">
        {/* Session Info */}
        <Card>
          <CardContent className="p-4">
            <h2 className="font-medium text-blue-700">{sessionData?.title}</h2>
            <p className="text-sm text-gray-500">
              {sessionData?.course} • {new Date(sessionData?.date).toLocaleDateString()}, {sessionData?.time}
              <br />
              Instructor: {sessionData?.instructor}
            </p>
            <p className="text-sm text-gray-600 mt-2">{sessionData?.description}</p>
            <div className="flex items-center justify-between mt-2">
              <p className="text-sm text-gray-500 flex items-center">
                <Users className="h-4 w-4 mr-1" /> {participantCount} participants
              </p>
              {isRecording && (
                <p className="text-sm text-red-500 flex items-center">
                  <Video className="h-4 w-4 mr-1" /> Recording
                </p>
              )}
              {!isLive && (
                <p className="text-sm text-amber-500 flex items-center">
                  <AlertCircle className="h-4 w-4 mr-1" /> Waiting for instructor
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Video Section */}
        <div className="relative rounded-lg overflow-hidden bg-black h-64">
          {isInstructor ? (
            // Instructor view (shows their own video)
            <video
              ref={localVideoRef}
              className="absolute inset-0 w-full h-full object-cover"
              autoPlay
              playsInline
              muted
            />
          ) : (
            // Student view (shows instructor's video)
            <video ref={remoteVideoRef} className="absolute inset-0 w-full h-full object-cover" autoPlay playsInline />
          )}

          {/* Local video preview (for students) */}
          {!isInstructor && (
            <video
              ref={localVideoRef}
              className={`absolute bottom-2 right-2 w-1/3 h-1/4 object-cover rounded border-2 border-white z-10 ${
                isCameraOn ? "block" : "hidden"
              }`}
              autoPlay
              playsInline
              muted
            />
          )}

          {/* Camera off indicator */}
          {!isCameraOn && (
            <div className="absolute bottom-2 right-2 w-1/3 h-1/4 bg-gray-800 rounded border-2 border-white z-10 flex items-center justify-center">
              <CameraOff className="text-white h-6 w-6" />
            </div>
          )}

          {/* Controls */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-center space-x-3">
            <button onClick={toggleMic} className={`rounded-full p-2 ${isMicOn ? "bg-blue-600" : "bg-red-600"}`}>
              {isMicOn ? <Mic className="h-6 w-6 text-white" /> : <MicOff className="h-6 w-6 text-white" />}
            </button>
            <button onClick={toggleCamera} className={`rounded-full p-2 ${isCameraOn ? "bg-blue-600" : "bg-red-600"}`}>
              {isCameraOn ? <Camera className="h-6 w-6 text-white" /> : <CameraOff className="h-6 w-6 text-white" />}
            </button>
            <button onClick={endCall} className="rounded-full p-2 bg-red-600">
              <PhoneOff className="h-6 w-6 text-white" />
            </button>

            {/* Instructor-only controls */}
            {isInstructor && (
              <>
                <button
                  onClick={toggleRecording}
                  className={`rounded-full p-2 ${isRecording ? "bg-red-600" : "bg-blue-600"}`}
                >
                  <Video className="h-6 w-6 text-white" />
                </button>
                <button onClick={muteAllParticipants} className="rounded-full p-2 bg-blue-600">
                  <MicOff className="h-6 w-6 text-white" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Chat and Participants Tabs */}
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex">
            <button
              className={`flex-1 py-2 flex items-center justify-center space-x-1 ${
                activeTab === "chat" ? "bg-blue-600 text-white" : "bg-white text-gray-700"
              }`}
              onClick={() => setActiveTab("chat")}
            >
              <MessageSquare className="h-4 w-4" />
              <span>Chat</span>
            </button>
            <button
              className={`flex-1 py-2 flex items-center justify-center space-x-1 ${
                activeTab === "participants" ? "bg-blue-600 text-white" : "bg-white text-gray-700"
              }`}
              onClick={() => setActiveTab("participants")}
            >
              <Users className="h-4 w-4" />
              <span>Participants ({participantCount})</span>
            </button>
          </div>
          <div className="p-4">
            {activeTab === "chat" ? (
              <>
                <div className="h-40 overflow-y-auto mb-3">
                  {messages.map((msg) => (
                    <div key={msg.id} className="mb-3">
                      <p
                        className={`text-xs font-medium ${msg.userType === "instructor" ? "text-blue-600" : "text-gray-600"}`}
                      >
                        {msg.name}
                      </p>
                      <p className="text-sm">{msg.text}</p>
                    </div>
                  ))}
                </div>
                <form onSubmit={handleSendMessage} className="flex space-x-2">
                  <Input
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="Type a message..."
                    className="flex-1"
                  />
                  <Button type="submit" size="sm">
                    Send
                  </Button>
                </form>
              </>
            ) : (
              <div className="h-48 overflow-y-auto">
                <div className="font-medium mb-2">Instructor</div>
                <div className="pl-2 mb-3">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center mr-2">
                      <span className="text-blue-600 font-medium">
                        {sessionData?.instructor
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm">{sessionData?.instructor} (Host)</p>
                    </div>
                  </div>
                </div>
                <div className="font-medium mb-2">Students ({participantCount - 1})</div>
                <div className="pl-2 space-y-2">
                  {isInstructor ? (
                    connectedStudents.length > 0 ? (
                      connectedStudents.map((studentId, i) => (
                        <div key={i} className="flex items-center">
                          <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center mr-2">
                            <span className="text-gray-600 font-medium">S{i + 1}</span>
                          </div>
                          <div>
                            <p className="text-sm">Student {i + 1}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="flex items-center justify-center text-gray-500 py-4">
                        <UserPlus className="h-5 w-5 mr-2" />
                        <p>Waiting for students to join</p>
                      </div>
                    )
                  ) : (
                    <div className="flex items-center">
                      <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center mr-2">
                        <span className="text-gray-600 font-medium">You</span>
                      </div>
                      <div>
                        <p className="text-sm">You</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </MobileLayout>
  )
}

export default LiveSession
