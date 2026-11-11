package main

import (
	"fmt"
	"net"
	"os"
)

func ErrorHandle(err error) {
	if err != nil {
		fmt.Println("We have a error: ", err)
		fmt.Println("Exitting")
		os.Exit(0)
	}
}

func main() {
	fmt.Println("Server Initiated...")

	ServerAddr, err := net.ResolveUDPAddr("udp", ":10001")
	ErrorHandle(err)
	fmt.Println("Address solved...")

	ServerConn, err := net.ListenUDP("udp", ServerAddr)
	ErrorHandle(err)
	fmt.Println("Server Working...")
	defer ServerConn.Close()

	buf := make([]byte, 1024)
	fmt.Println("Waiting Mensages...")
	for {
		n, addr, err := ServerConn.ReadFromUDP(buf)

		fmt.Println("Received ", string(buf[0:n]), " from ", addr)

		if err != nil {
			fmt.Println("Error: ", err)
		}
	}
}
