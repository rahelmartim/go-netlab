package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"time"
)

func ErrorHandle(err error) {
	if err != nil {
		fmt.Println("We have a error: ", err)
		fmt.Println("Exitting")
		os.Exit(0)
	}
}

func main() {
	fmt.Println("Client Initiated...")

	ServerAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:10001")
	ErrorHandle(err)

	fmt.Println("Address Solved...")

	LocalAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	ErrorHandle(err)

	Conn, err := net.DialUDP("udp", LocalAddr, ServerAddr)
	ErrorHandle(err)

	fmt.Println("Client Connected...")

	defer Conn.Close()
	i := 0
	for {
		msg_pack := strconv.Itoa(i)
		i++
		buf := []byte(msg_pack)

		fmt.Println("sending mensage: ", msg_pack)

		_, err := Conn.Write(buf)

		if err != nil {
			fmt.Println(msg_pack, err)
		}

		time.Sleep(time.Second * 1)
	}

}
